import { concatMap, from, map, filter } from 'rxjs';
import { API, APIEvent, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { BoschSmartHomeBridge, BoschSmartHomeBridgeBuilder, BshbResponse, BshbUtils } from 'bosch-smart-home-bridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BoschDevice as BoschDevice, BoschServiceId as BoschServiceId, BoschRoom as BoschRoom, AccessoryContext } from './types';
import { pretty } from './utils';
import { BoschRoomClimateControlAccessory } from './platformAccessory';

export class BoschRoomClimateControlPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory<AccessoryContext>[] = [];
  private readonly rooms: BoschRoom[] = [];

  public bshb!: BoschSmartHomeBridge;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.initializeBoschSmartHomeBridge();
      this.initializeRoomClimate();
    });
  }

  initializeBoschSmartHomeBridge(): void {
    const certificate = BshbUtils.generateClientCertificate();
    const bshb = BoschSmartHomeBridgeBuilder.builder()
      .withHost(this.config.host)
      .withClientCert(this.config.clientCert ?? certificate.cert)
      .withClientPrivateKey(this.config.clientKey ??certificate.private)
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

  initializeRoomClimate(): void {
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

  createAccessory(device: BoschDevice): void {
    this.log.info(`Creating accessory for device ${device.id}...`);

    const uuid = this.api.hap.uuid.generate(device.serial);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info(`Restoring accessory for device ${device.id} from cache...`);
      new BoschRoomClimateControlAccessory(this, existingAccessory);
      return;
    }

    this.log.info(`Adding new accessory for device ${device.id}...`);

    const room = this.rooms.find(room => room.id === device.roomId);
    const accessoryName = `${device.name} ${room?.name}`;

    const accessory = new this.api.platformAccessory<AccessoryContext>(accessoryName, uuid);
    accessory.context.device = device;

    new BoschRoomClimateControlAccessory(this, accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.accessories.push(accessory);
  }

}
