import { concatMap, from, map, filter } from 'rxjs';
import { API, APIEvent, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { BoschSmartHomeBridge, BoschSmartHomeBridgeBuilder, BshbResponse, BshbUtils } from 'bosch-smart-home-bridge';

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
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public bshb!: BoschSmartHomeBridge;

  private readonly roomClimateControlAccessories: BoschRoomClimateControlAccessory[] = [];
  private readonly platformAccessories: PlatformAccessory<AccessoryContext>[] = [];
  private readonly rooms: BoschRoom[] = [];

  private longPollingId: string | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.initializeBoschSmartHomeBridge();
      this.initializeRoomClimate();
      this.startLongPolling();
    });

    api.on(APIEvent.SHUTDOWN, () => {
      this.stopLongPolling();

      this.roomClimateControlAccessories.forEach(accessory => {
        accessory.dispose();
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.platformAccessories.push(accessory);
  }

  private initializeBoschSmartHomeBridge(): void {
    const certificate = this.config.clientCert != null ? {
      cert: '-----BEGIN CERTIFICATE-----\n' + this.config.clientCert + '\n-----END CERTIFICATE-----',
      private: '-----BEGIN RSA PRIVATE KEY-----\n' + this.config.clientKey + '\n-----END RSA PRIVATE KEY-----',
    } : BshbUtils.generateClientCertificate();

    const bshb = BoschSmartHomeBridgeBuilder.builder()
      .withHost(this.config.host)
      .withClientCert(certificate.cert)
      .withClientPrivateKey(certificate.private)
      .build();

    const clientName = this.config.clientName ?? PLUGIN_NAME;
    const clientIdentifier = this.config.clientId ?? BshbUtils.generateIdentifier();

    if (this.config.systemPassword == null) {
      this.log.warn('No system password provided');
    }

    this.log.info('Attempting to pair with BSHC if needed...');
    bshb.pairIfNeeded(clientName, clientIdentifier, this.config.systemPassword);

    this.bshb = bshb;
  }

  private initializeRoomClimate(): void {
    this.bshb
      .getBshcClient()
      .getRooms()
      .pipe(
        concatMap((response: BshbResponse<BoschRoom[]>) => {
          const rooms = response.parsedResponse;

          this.log.info(`Discovered ${(rooms.length)} rooms`);
          this.log.debug(pretty(rooms));

          this.rooms.push(...rooms);
          return this.bshb.getBshcClient().getDevices();
        }),
        concatMap((response: BshbResponse<BoschDevice[]>) => {
          const devices = response.parsedResponse;

          this.log.info(`Discovered ${(devices.length)} devices`);
          this.log.debug(pretty(devices));

          return from(devices);
        }), filter(device => {
          const deviceServiceIds = Object.values(device.deviceServiceIds);

          return deviceServiceIds?.includes(BoschServiceId.RoomClimateControl)
            && deviceServiceIds?.includes(BoschServiceId.TemperatureLevel);
        }), map(device => {
          this.log.info(`Identified device ${device.id} with room climate control capabilities`);
          this.log.debug(pretty(device));
          this.createAccessory(device);
        }))
      .subscribe();
  }

  private startLongPolling(): void {
    this.log.debug('Attempting to start long polling...');

    if(this.longPollingId != null) {
      this.log.debug(`Long polling has already been started with ID ${this.longPollingId}`);
      return;
    }

    this.bshb
      .getBshcClient()
      .subscribe()
      .subscribe((response) => {
        this.longPollingId = response.parsedResponse.result;

        if (this.longPollingId == null) {
          this.log.info('Could not start long polling');
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
    if (this.longPollingId == null) {
      this.log.debug('Cannot stop long polling without an ID');
      return;
    }

    this.log.debug('Attempting to stop long polling...');

    const longPollingId = this.longPollingId;
    this.longPollingId = null;

    this.bshb
      .getBshcClient()
      .unsubscribe(longPollingId)
      .subscribe(() => {});
  }

  private handleLongPollingResult(deviceServiceDataResult: BoschDeviceServiceData[]) {
    this.log.debug('Handeling long polling result...');
    this.log.debug(pretty(deviceServiceDataResult));

    for (const deviceServiceData of deviceServiceDataResult) {
      const accessory = this.roomClimateControlAccessories.find(accessory => {
        return accessory.platformAccessory.context.device.id === deviceServiceData.deviceId;
      });

      if (accessory != null) {
        accessory.handleDeviceServiceDataUpdate(deviceServiceData);
      }
    }
  }

  private createAccessory(device: BoschDevice): void {
    this.log.info(`Creating accessory for device ID ${device.id}...`);

    const uuid = this.api.hap.uuid.generate(device.serial);
    const existingAccessory = this.platformAccessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info(`Restoring accessory for device ID ${device.id} from cache...`);

      existingAccessory.context.device = device;
      this.api.updatePlatformAccessories([existingAccessory]);

      const roomClimateControlAccessory = new BoschRoomClimateControlAccessory(this, existingAccessory);
      this.roomClimateControlAccessories.push(roomClimateControlAccessory);

      return;
    }

    this.log.info(`Adding new accessory for device ID ${device.id}...`);

    const room = this.rooms.find(room => room.id === device.roomId);
    const accessoryName = `${device.name} ${room?.name}`;

    const accessory = new this.api.platformAccessory<AccessoryContext>(accessoryName, uuid);
    accessory.context.device = device;

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

    const roomClimateControlAccessory = new BoschRoomClimateControlAccessory(this, accessory);
    this.roomClimateControlAccessories.push(roomClimateControlAccessory);
  }
}
