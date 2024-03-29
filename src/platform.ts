import * as fs from 'fs';
import {
  API,
  APIEvent,
  Categories,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { BoschSmartHomeBridgeBuilder, BshbError, BshbUtils } from 'bosch-smart-home-bridge';
import PQueue from 'p-queue';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BoschRoomClimateControlAccessory } from './accessory';
import { pretty } from './utils';

import {
  BoschDevice,
  BoschRoom,
  AccessoryContext,
  BoschDeviceServiceData,
} from './types';
import { BshcApi } from './bshcApi';

export type ConfigSchema = {
  host: string;
  systemPassword: string;
  stateSyncFrequency: string;
  accessorySyncFrequency: string;
  clientName: string;
  clientId: string;
  clientCert: string;
  clientKey: string;
  disableVerboseLogs: boolean;
};

export class BoschRoomClimateControlPlatform implements DynamicPlatformPlugin {
  private timeoutId!: NodeJS.Timeout;

  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly queue = new PQueue({concurrency: 1, timeout: 5_000});

  public bshcApi!: BshcApi;

  private readonly controllers: BoschRoomClimateControlAccessory[] = [];
  private readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  private longPollingId: string | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      if (this.config.host == null) {
        this.log.warn('Plugin configuration incomplete:');
        this.log.warn('Provide the host name (IP Address) of the Bosch Smart Home Controller');
        return;
      }

      if (this.config.clientCert == null && this.config.systemPassword == null) {
        this.log.warn('Plugin configuration incomplete:');
        this.log.warn('Either a SSL key pair or the system password is required. Please configure and restart the plugin.');
        return;
      }

      if (this.config.clientCert != null && this.config.clientKey == null) {
        this.log.warn('Plugin configuration incomplete:');
        this.log.warn('A private key must be provided alongside a client certificate. Please configure and restart the plugin.');
        return;
      }

      await this.initializeBoschSmartHomeBridge();
      await this.initializeRoomClimate();
      await this.syncAccessories();

      this.log.info('Starting long polling...');
      this.startLongPolling();

      this.log.info('Starting periodic accessory updates...');
      this.startPeriodicAccessorySync();
    });

    api.on(APIEvent.SHUTDOWN, () => {
      this.stopLongPolling();
      this.stopPeriodicAccessorySync();

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

    const certificate = this.isConfigured('clientCert') ? {
      cert: '-----BEGIN CERTIFICATE-----\r\n' + this.config.clientCert + '\r\n-----END CERTIFICATE-----\r\n',
      private: '-----BEGIN RSA PRIVATE KEY-----\r\n' + this.config.clientKey + '\r\n-----END RSA PRIVATE KEY-----\r\n',
    } : BshbUtils.generateClientCertificate();

    const bshb = BoschSmartHomeBridgeBuilder.builder()
      .withHost(this.config.host)
      .withClientCert(certificate.cert)
      .withClientPrivateKey(certificate.private)
      .withLogger({
        fine: this.config.disableVerboseLogs ?
          () => {} :
          this.log.debug.bind(this.log),
        debug: this.log.debug.bind(this.log),
        info: this.log.info.bind(this.log),
        warn: this.log.warn.bind(this.log),
        error: this.log.error.bind(this.log),
      })
      .build();

    this.bshcApi = new BshcApi(bshb);

    const clientName = this.config.clientName ?? PLUGIN_NAME;
    const clientId = this.config.clientId ?? BshbUtils.generateIdentifier();

    this.log.info('Attempting to pair with BSHC if needed...');

    this.updateConfig({
      certificate,
      clientId,
      clientName,
    });

    await this.bshcApi.pair(clientName, clientId, this.config.systemPassword);
  }

  private updateConfig(config: {certificate: {cert: string; private: string}; clientId: string; clientName: string}): void {
    this.log.info('Loading platform config...');

    const configPath = this.api.user.configPath();

    let configString: string;
    try {
      configString = fs.readFileSync(configPath, 'utf8');
    } catch(e) {
      this.log.warn(`Could not load config file ${configPath}`);
      return;
    }

    if (configString == null) {
      this.log.warn(`Received empty config from file ${configPath}`);
      return;
    }

    const configJson = JSON.parse(configString);
    const originalConfigJson = (' ' + configJson).slice(1);

    const platformId = configJson.platforms.findIndex(platform => {
      return platform.platform === PLATFORM_NAME;
    });

    if (platformId == null) {
      this.log.warn(`No platform ${PLATFORM_NAME} found in config file ${configPath}`);
      return;
    }

    if (!this.isConfigured('clientCert')) {
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

    if (!this.isConfigured('clientId')) {
      this.log.info('Updating platform config with clientId...');

      configJson.platforms[platformId].clientId = config.clientId;
    }

    if (!this.isConfigured('clientName')) {
      this.log.info('Updating platform config with clientName...');
      configJson.platforms[platformId].clientName = config.clientName;
    }

    if (configJson === originalConfigJson) {
      return;
    }

    try {
      fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2));
    } catch(e) {
      this.log.warn(`Could not update config file ${configPath}`, e);
    }
  }

  private async initializeRoomClimate(): Promise<void> {
    this.log.info('Initializing room climate devices...');

    const devices = await this.bshcApi.getDevices();

    for (const device of devices) {
      await this.createAccessory(device);
    }
  }

  private async createAccessory(device: BoschDevice): Promise<void> {
    this.log.info(`Creating accessory for device ID ${device.id}...`);

    const uuid = this.api.hap.uuid.generate(device.serial);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    let room: BoschRoom;
    try {
      room = await this.bshcApi.getRoom(device.roomId);
    } catch(e) {
      this.log.warn(`Cannot add accessory for device ID ${device.id}, failed to fetch room`);
      return;
    }

    if (existingAccessory) {
      this.log.info(`Restoring accessory for device ID ${device.id} from cache...`);

      existingAccessory.context.device = device;
      existingAccessory.context.room = room;
      existingAccessory.displayName = this.getAccessoryDisplayName(room.name, device.name);

      this.api.updatePlatformAccessories([existingAccessory]);

      const controller = new BoschRoomClimateControlAccessory(this, existingAccessory);
      this.controllers.push(controller);

      return;
    }

    this.log.info(`Adding new accessory for device ID ${device.id}...`);

    const accessory = new this.api.platformAccessory<AccessoryContext>(
      this.getAccessoryDisplayName(room.name, device.name),
      uuid,
      Categories.THERMOSTAT,
    );

    accessory.context.device = device;
    accessory.context.room = room;

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

    const controller = new BoschRoomClimateControlAccessory(this, accessory);
    this.controllers.push(controller);
  }

  private getAccessoryDisplayName(roomName: string, deviceName: string): string {
    return `${roomName} ${deviceName?.replace(/[^a-z0-9]/gi, '') ?? 'Room Climate Control'}`;
  }

  private async updateAccessory(accessory: PlatformAccessory): Promise<void> {
    this.api.updatePlatformAccessories([accessory]);
  }

  private async removeAccessory(uuid: string): Promise<void> {
    this.log.info(`Attempting to remove accesspry with UUID ${uuid}...`);

    const accessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (accessory == null) {
      this.log.info(`Could not find accessory accessory UUID ${uuid} to remove`);
      return;
    }

    const controller = this.controllers.find(controller => {
      return controller.getDeviceContext().id === accessory.context.device.id;
    });

    if (controller != null) {
      controller.setUnavailable();
      controller.dispose();
      this.controllers.splice(this.controllers.indexOf(controller), 1);
    }

    this.log.info(`Removing accessory ${accessory.displayName}...`);

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.splice(this.accessories.indexOf(accessory), 1);
  }

  private async syncAccessories(): Promise<void> {
    this.log.info('Syncing accessories...');

    const devices = await this.queue.add(async () => {
      try {
        return this.bshcApi.getDevices();
      } catch(e) {
        this.log.error('Error fetiching devices', (e as BshbError).message);
        return null;
      }
    });

    if (devices == null) {
      this.log.info('Could not sync accessories, trying again next time');
      return;
    }

    this.log.debug('Recieved devices to sync');
    this.log.debug(pretty(devices));

    for (const accessory of this.accessories) {
      const device = devices.find(device => device.id === accessory.context.device.id);

      if (device == null) {
        await this.removeAccessory(accessory.UUID);
      } else {
        accessory.context.device = device;
        await this.updateAccessory(accessory);
      }
    }

    for (const device of devices) {
      const controller = this.controllers.find(controller => controller.getDeviceContext().id === device.id);

      if (controller == null) {
        await this.createAccessory(device);
      }
    }
  }

  private startPeriodicAccessorySync(): void {
    const minutes = this.config.accessorySyncFrequency ??
    this.config.accessoryUpdateFrequency ??
    this.config.accessoryUpdates ??
    this.config.periodicUpdates;

    if (minutes == null || minutes < 1) {
      this.log.info('Periodic accessory updates are disabled');
      return;
    }

    this.timeoutId = setTimeout(async () => {
      this.log.debug('Running periodic accessory updates...');

      try {
        await this.syncAccessories();
      } catch(e) {
        this.log.warn(`Could not update accessories, retrying during next cycle in ${minutes} minutes`, e);
      }

      this.startPeriodicAccessorySync();
    }, minutes * 60 * 1000);
  }

  private stopPeriodicAccessorySync(): void {
    if (this.timeoutId == null) {
      return;
    }

    this.log.info('Stopping periodic accessory updates...');
    clearTimeout(this.timeoutId);
  }

  private async startLongPolling(): Promise<void> {
    this.log.info('Attempting to start long polling...');

    if(this.longPollingId != null) {
      this.log.info(`Long polling has already been started with ID ${this.longPollingId}`);
      return;
    }

    this.longPollingId = await this.bshcApi.subscribe();

    if (this.longPollingId == null) {
      this.log.warn('Could not start long polling, no ID returned from API');
      return;
    }

    this.poll();
  }

  private async stopLongPolling(): Promise<void> {
    this.log.info('Attempting to stop long polling...');

    if (this.longPollingId == null) {
      this.log.warn('Cannot stop long polling without an ID');
      return;
    }

    const longPollingId = this.longPollingId;
    this.longPollingId = null;

    await this.bshcApi.unsubscribe(longPollingId);
  }

  private async poll(): Promise<void> {
    if (this.longPollingId == null) {
      this.log.warn('Cannot long poll without an ID');
      return;
    }

    this.log.debug(`Opening long polling connection with ID ${this.longPollingId}...`);

    let result: BoschDeviceServiceData[];

    try {
      result = await this.bshcApi.poll(this.longPollingId);
    } catch(e) {
      this.log.error('Failed to open long polling connection', (e as BshbError).message);
      await this.stopLongPolling();
      await this.startLongPolling();
      return;
    }

    this.handleLongPollingResult(result);
    this.poll();
  }

  private handleLongPollingResult(deviceServiceDataResult: BoschDeviceServiceData[]): void {
    this.log.debug('Handeling long polling result...');
    this.log.debug(pretty(deviceServiceDataResult));

    for (const deviceServiceData of deviceServiceDataResult) {
      const controller = this.controllers.find(controller => {
        return controller.platformAccessory.context.device.id === deviceServiceData.deviceId;
      });

      if (controller != null) {
        controller.onBoschEvent(deviceServiceData);
      }
    }
  }

  private isConfigured(key: keyof ConfigSchema): boolean {
    if (this.config[key] === undefined) {
      return false;
    }

    return true;
  }
}