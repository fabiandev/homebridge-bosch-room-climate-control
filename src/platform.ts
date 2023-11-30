import { switchMap, from, of, pipe, map, mergeMap, filter } from 'rxjs';
import { API, APIEvent, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { BoschSmartHomeBridge, BoschSmartHomeBridgeBuilder, BshbResponse, BshbUtils } from 'bosch-smart-home-bridge';
import { PLUGIN_NAME } from './settings';
import { Device as BoschDevice, Service as BoschService } from './types';
import { pretty } from './utils';

export class BoschRoomClimateControlPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  private bshb!: BoschSmartHomeBridge;

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

  initializeRoomClimate() {
    this.bshb
      .getBshcClient()
      .getDevices()
      .pipe(switchMap((response: BshbResponse<BoschDevice[]>) => {
        this.log.info(`Discovered ${(response.parsedResponse.length)} devices`);
        return from(response.parsedResponse);
      }), filter(device => {
        const deviceServiceIds = Object.values(device.deviceServiceIds);
        return deviceServiceIds?.includes(BoschService.RoomClimateControl)
          && deviceServiceIds?.includes(BoschService.TemperatureLevel);
      }), map(device => {
        this.log.info(`Identified device ${device.id} with room climate control capabilities`);
        this.log.debug(pretty(device));
      }))
      .subscribe();
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

}
