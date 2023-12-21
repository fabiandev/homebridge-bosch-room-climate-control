import * as fs from 'fs';
import { concatMap, from, filter, lastValueFrom, toArray } from 'rxjs';
import { API, APIEvent, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { BoschSmartHomeBridge, BoschSmartHomeBridgeBuilder, BshbResponse, BshbUtils } from 'bosch-smart-home-bridge';
import PQueue from 'p-queue';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { pretty } from './utils';
import { BoschRoomClimateControlAccessory } from './platformAccessory';

import {
  BoschDevice,
  BoschServiceId,
  BoschRoom,
  AccessoryContext,
  BoschDeviceServiceData,
} from './types';

export class BoschRoomClimateControlPlatform implements DynamicPlatformPlugin {
  private timeoutId!: NodeJS.Timeout;

  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly queue = new PQueue({concurrency: 1, timeout: 5_000});

  public bshb!: BoschSmartHomeBridge;

  private readonly controllers: BoschRoomClimateControlAccessory[] = [];
  private readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  private longPollingId: string | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      if (this.config.clientCert == null && this.config.systemPassword == null) {
        this.log.info('Plugin configuration incomplete:');
        this.log.info('Either a SSL key pair or the system password is required. Please configure and restart the plugin.');
        return;
      }

      if (this.config.clientCert != null && this.config.clientKey == null) {
        this.log.info('Plugin configuration incomplete:');
        this.log.info('A private key must be provided alongside a client certificate. Please configure and restart the plugin.');
        return;
      }

      await this.initializeBoschSmartHomeBridge();
      await this.initializeRoomClimate();
      await this.updateAccessories();

      this.log.info('Starting long polling...');
      this.startLongPolling();

      this.log.info('Starting periodic accessory updates...');
      this.startPeriodicAccessoryUpdates();
    });

    api.on(APIEvent.SHUTDOWN, () => {
      this.stopLongPolling();
      this.stopPeriodicAccessoryUpdates();

      this.controllers.forEach(accessory => {
        accessory.dispose();
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.accessories.push(accessory);
  }

  private async initializeBoschSmartHomeBridge() {
    this.log.info('Initializing Bosch Smart Home bridge...');

    const certificate = this.isClientCertConfigured() ? {
      cert: '-----BEGIN CERTIFICATE-----\r\n' + this.config.clientCert + '\r\n-----END CERTIFICATE-----\r\n',
      private: '-----BEGIN RSA PRIVATE KEY-----\r\n' + this.config.clientKey + '\r\n-----END RSA PRIVATE KEY-----\r\n',
    } : BshbUtils.generateClientCertificate();

    const bshb = BoschSmartHomeBridgeBuilder.builder()
      .withHost(this.config.host)
      .withClientCert(certificate.cert)
      .withClientPrivateKey(certificate.private)
      .withLogger({
        fine: this.log.debug.bind(this.log),
        debug: this.log.debug.bind(this.log),
        info: this.log.info.bind(this.log),
        warn: this.log.warn.bind(this.log),
        error: this.log.error.bind(this.log),
      })
      .build();

    this.bshb = bshb;

    const clientName = this.config.clientName ?? PLUGIN_NAME;
    const clientId = this.config.clientId ?? BshbUtils.generateIdentifier();

    this.log.info('Attempting to pair with BSHC if needed...');

    this.updateConfig({
      certificate,
      clientId,
      clientName,
    });

    await lastValueFrom(
      bshb.pairIfNeeded(clientName, clientId, this.config.systemPassword),
    );
  }

  private isClientCertConfigured(): boolean {
    if (this.config.clientCert == null) {
      return false;
    }

    if (typeof this.config.clientCert === 'string' && this.config.clientCert.trim().length > 0) {
      return true;
    }

    return false;
  }

  private isClientIdConfigured(): boolean {
    if (this.config.clientId == null) {
      return false;
    }

    if (typeof this.config.clientId === 'string' && this.config.clientId.trim().length > 0) {
      return true;
    }

    return false;
  }

  private isClientNameConfigured(): boolean {
    if (this.config.clientName == null) {
      return false;
    }

    if (typeof this.config.clientName === 'string' && this.config.clientName.trim().length > 0) {
      return true;
    }

    return false;
  }

  private updateConfig(config: {certificate: {cert: string; private: string}; clientId: string; clientName: string}): void {
    if (this.isClientCertConfigured() && this.isClientIdConfigured() && this.isClientNameConfigured()) {
      return;
    }

    this.log.info('Attempting to update platform config...');

    const configPath = this.api.user.configPath();

    let configString: string;
    try {
      configString = fs.readFileSync(configPath, 'utf8');
    } catch(e) {
      this.log.info('Could not load config file');
      return;
    }

    if (configString == null) {
      this.log.info('Cannot update config in empty file');
      return;
    }

    const configJson = JSON.parse(configString);

    const platformId = configJson.platforms.findIndex(platform => {
      return platform.platform === PLATFORM_NAME;
    });

    if (platformId == null) {
      this.log.info(`No platform ${this.log.debug('Config file is empty')} found in config`);
      return;
    }

    if (!this.isClientCertConfigured()) {
      this.log.info('Updating platform config with key pair...');

      configJson.platforms[platformId].clientCert = config.certificate.cert
        .replace('-----BEGIN CERTIFICATE-----', '')
        .replace('-----END CERTIFICATE-----', '')
        .replaceAll('\r', '')
        .replaceAll('\n', '');

      configJson.platforms[platformId].clientKey = config.certificate.private
        .replace('-----BEGIN RSA PRIVATE KEY-----', '')
        .replace('-----END RSA PRIVATE KEY-----', '')
        .replaceAll('\r', '')
        .replaceAll('\n', '');
    }

    if (!this.isClientIdConfigured()) {
      this.log.info('Updating platform config with clientId...');

      configJson.platforms[platformId].clientId = config.clientId;
    }

    if (!this.isClientNameConfigured()) {
      this.log.info('Updating platform config with clientName...');
      configJson.platforms[platformId].clientName = config.clientName;
    }

    try {
      fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2));
    } catch(e) {
      this.log.warn('Could not update config file', e);
    }
  }

  private async initializeRoomClimate(): Promise<void> {
    this.log.info('Initializing room climate devices...');

    const devices = await this.getDevices();

    for (const device of devices) {
      await this.createAccessory(device);
    }
  }

  private startPeriodicAccessoryUpdates(): void {
    const minutes = this.config.accessoryUpdateFrequency ?? this.config.accessoryUpdates ?? this.config.periodicUpdates;

    if (minutes == null || minutes < 1) {
      this.log.info('Periodic accessory updates are disabled');
      return;
    }

    this.timeoutId = setTimeout(async () => {
      this.log.debug('Running periodic accessory updates...');

      try {
        await this.updateAccessories();
      } catch(e) {
        this.log.warn(`Could not update accessories, retrying during next cycle in ${minutes} minutes`, e);
      }

      this.startPeriodicAccessoryUpdates();
    }, minutes * 60 * 1000);
  }

  private stopPeriodicAccessoryUpdates(): void {
    if (this.timeoutId == null) {
      return;
    }

    this.log.info('Stopping periodic accessory updates...');
    clearTimeout(this.timeoutId);
  }

  private async getDevices(): Promise<BoschDevice[]> {
    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .getDevices()
        .pipe(
          concatMap((response: BshbResponse<BoschDevice[]>) => {
            const devices = response.parsedResponse;
            return from(devices);
          }), filter(device => {
            const deviceServiceIds = Object.values(device.deviceServiceIds);

            return deviceServiceIds?.includes(BoschServiceId.RoomClimateControl)
            && deviceServiceIds?.includes(BoschServiceId.TemperatureLevel);
          }),
          toArray(),
        ),
    );
  }

  private async updateAccessories(): Promise<void> {
    this.log.info('Updating accessories...');

    const devices = await this.queue.add(async () => this.getDevices());

    for (const accessory of this.accessories) {
      const index = devices.findIndex(device => device.id === accessory.context.device.id);

      if (index === -1) {
        await this.removeAccessory(accessory.UUID);
      }
    }

    for (const device of devices) {
      const index = this.controllers.findIndex(accessory => accessory.getDevice().id === device.id);

      if (index === -1) {
        await this.createAccessory(device);
      }
    }
  }

  private startLongPolling(): void {
    if(this.longPollingId != null) {
      this.log.info(`Long polling has already been started with ID ${this.longPollingId}`);
      return;
    }

    this.bshb
      .getBshcClient()
      .subscribe()
      .subscribe((response) => {
        this.longPollingId = response.parsedResponse.result;

        if (this.longPollingId == null) {
          this.log.info('Could not start long polling, no ID returned from API');
          return;
        }

        this.poll();
      });
  }

  private poll(): void {
    if (this.longPollingId == null) {
      this.log.debug('Cannot long poll without an ID');
      return;
    }

    this.log.debug(`Opening long polling connection with ID ${this.longPollingId}...`);

    this.bshb
      .getBshcClient()
      .longPolling(this.longPollingId)
      .subscribe((response: BshbResponse<{
        jsonrpc: string;
        result: BoschDeviceServiceData[];
      }>) => {
        this.handleLongPollingResult(response.parsedResponse.result);
        this.poll();
      });
  }

  private stopLongPolling(): void {
    this.log.info('Attempting to stop long polling...');

    if (this.longPollingId == null) {
      this.log.info('Cannot stop long polling without an ID');
      return;
    }

    const longPollingId = this.longPollingId;
    this.longPollingId = null;

    this.bshb
      .getBshcClient()
      .unsubscribe(longPollingId)
      .subscribe(() => {});
  }

  private handleLongPollingResult(deviceServiceDataResult: BoschDeviceServiceData[]): void {
    this.log.debug('Handeling long polling result...');
    this.log.debug(pretty(deviceServiceDataResult));

    for (const deviceServiceData of deviceServiceDataResult) {
      const controller = this.controllers.find(accessory => {
        return accessory.platformAccessory.context.device.id === deviceServiceData.deviceId;
      });

      if (controller != null) {
        controller.handleDeviceServiceDataUpdate(deviceServiceData);
      }
    }
  }

  private async createAccessory(device: BoschDevice): Promise<void> {
    this.log.info(`Creating accessory for device ID ${device.id}...`);

    const uuid = this.api.hap.uuid.generate(device.serial);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    let room: BoschRoom;
    try {
      room = (await lastValueFrom<BshbResponse<BoschRoom>>(this.bshb.getBshcClient().getRoom(device.roomId))).parsedResponse;
    } catch(e) {
      this.log.warn(`cannot add accessory for device ID ${device.id}, failed to fetch room`);
      return;
    }

    if (existingAccessory) {
      this.log.info(`Restoring accessory for device ID ${device.id} from cache...`);

      existingAccessory.context.device = device;
      this.api.updatePlatformAccessories([existingAccessory]);

      const controller = new BoschRoomClimateControlAccessory(this, existingAccessory);
      this.controllers.push(controller);

      return;
    }

    this.log.info(`Adding new accessory for device ID ${device.id}...`);

    const accessoryName = `${device.name} ${room?.name}`;

    const accessory = new this.api.platformAccessory<AccessoryContext>(accessoryName, uuid);
    accessory.context.device = device;

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

    const controller = new BoschRoomClimateControlAccessory(this, accessory);
    this.controllers.push(controller);
  }

  private async removeAccessory(uuid: string): Promise<void> {
    this.log.info(`Attempting to remove accesspry with UUID ${uuid}...`);

    const accessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (accessory == null) {
      this.log.info(`Could not find accessory accessory UUID ${uuid} to remove`);
      return;
    }

    const controller = this.controllers.find(controller => controller.getDevice().id === accessory.context.device.id);

    if (controller != null) {
      controller.dispose();
      controller.setUnavailable();
      this.controllers.splice(this.controllers.indexOf(controller), 1);
    }

    this.log.info(`Removing accessory ${accessory.displayName}...`);

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.splice(this.accessories.indexOf(accessory), 1);
  }
}