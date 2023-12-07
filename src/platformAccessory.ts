import { Observable, switchMap, from, map, filter, lastValueFrom, iif, of, concatMap } from 'rxjs';
import { Service, PlatformAccessory, Characteristic, CharacteristicValue } from 'homebridge';

import * as packageJson from './package.json';

import {
  AccessoryContext,
  BoschService,
  BoschServiceId,
  BoschOperationMode,
  BoschRoomControlMode,
  BoschTemperatureLevelState,
} from './types';

import { BoschRoomClimateControlPlatform } from './platform';
import { BshbResponse } from 'bosch-smart-home-bridge';
import { BoschClimateControlState } from './types/BoschClimateControlState';

export enum DeviceState {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
  OFF = 'OFF',
}

export type AccessoryState = {
  currentTemperature: number;
  targetTemperature: number;
  deviceState: DeviceState;
};

type SupportedCurrentHeatingCoolingState = {
  [Characteristic.CurrentHeatingCoolingState.HEAT]: typeof Characteristic.CurrentHeatingCoolingState.HEAT;
  [Characteristic.CurrentHeatingCoolingState.OFF]: typeof Characteristic.CurrentHeatingCoolingState.OFF;
};

type SupportedTargetHeatingCoolingState = {
  [Characteristic.TargetHeatingCoolingState.AUTO]: typeof Characteristic.TargetHeatingCoolingState.AUTO;
  [Characteristic.TargetHeatingCoolingState.HEAT]: typeof Characteristic.TargetHeatingCoolingState.HEAT;
  [Characteristic.TargetHeatingCoolingState.OFF]: typeof Characteristic.TargetHeatingCoolingState.OFF;
};

export class BoschRoomClimateControlAccessory {
  private state: AccessoryState = {
    currentTemperature: 0,
    targetTemperature: 5,
    deviceState: DeviceState.OFF,
  };

  get type(): typeof Service.Thermostat {
    return this.platform.Service.Thermostat;
  }

  get service(): Service {
    return this.accessory.getService(this.type) || this.accessory.addService(this.type);
  }

  constructor(
        private readonly platform: BoschRoomClimateControlPlatform,
        private readonly accessory: PlatformAccessory<AccessoryContext>,
  ) {
    this.platform.log.info(`Creating accessory ${this.accessory.displayName}...`);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.deviceModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, packageJson.version);

    this.registerHandlers();
  }

  registerHandlers(): void {
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this))
      .setProps({
        validValues:[
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
        ],
      });

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this))
      .setProps({
        validValues:[
          this.platform.Characteristic.TargetHeatingCoolingState.AUTO,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
        ],
      });

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this))
      .setProps({
        minStep: 0.1,
      });

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this))
      .setProps({
        minStep: 0.5,
        minValue: 5,
        maxValue: 30,
      });

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this))
      .setProps({
        validValues:[
          this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
        ],
      });
  }

  isRoomClimateControlService(service: BoschService): service is BoschService<BoschClimateControlState> {
    if (service.id === BoschServiceId.RoomClimateControl) {
      return true;
    }

    return false;
  }

  isTemperatureLevelService(service: BoschService): service is BoschService<BoschTemperatureLevelState> {
    if (service.id === BoschServiceId.TemperatureLevel) {
      return true;
    }

    return false;
  }

  updateLocalState(): Observable<AccessoryState> {
    return this.platform.bshb.getBshcClient().getDeviceServices(this.accessory.context.device.id, 'all')
      .pipe(
        switchMap((response: BshbResponse<BoschService[]>) => {
          this.platform.log.debug(`Found ${(response.parsedResponse.length)} services for device ${this.accessory.context.device.id}`);
          return from(response.parsedResponse);
        }), filter(service => {
          return service.id === BoschServiceId.RoomClimateControl
        || service.id === BoschServiceId.TemperatureLevel;
        }), map(service => {
          if (this.isRoomClimateControlService(service)) {
            this.state.deviceState = this.extractDeviceState(service.state);
            this.state.targetTemperature = service.state.setpointTemperature;
          }

          if (this.isTemperatureLevelService(service)) {
            this.state.currentTemperature = this.extractCurrentTemperature(service.state);
          }

          return this.state;
        }),
      );
  }

  extractDeviceState(state: BoschClimateControlState): DeviceState {
    if (state.roomControlMode === BoschRoomControlMode.OFF) {
      return DeviceState.OFF;
    }

    if (state.operationMode === BoschOperationMode.AUTOMATIC) {
      return DeviceState.AUTO;
    }

    if (state.operationMode === BoschOperationMode.MANUAL) {
      return DeviceState.MANUAL;
    }

    return DeviceState.OFF;
  }

  extractCurrentTemperature(state: BoschTemperatureLevelState): number {
    return state.temperature;
  }

  getPath(deviceId: string, serviceId: BoschServiceId): string {
    return `devices/${deviceId}/services/${serviceId}`;
  }

  async handleCurrentHeatingCoolingStateGet(): Promise<keyof SupportedCurrentHeatingCoolingState> {
    this.platform.log.debug('Triggered GET CurrentHeatingCoolingState');

    const state = await lastValueFrom(this.updateLocalState());

    if (state.deviceState === DeviceState.OFF) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    if (this.state.currentTemperature > this.state.targetTemperature) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
  }

  async handleTargetHeatingCoolingStateGet(): Promise<keyof SupportedTargetHeatingCoolingState> {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    const state = await lastValueFrom(this.updateLocalState());

    switch(state.deviceState) {
      case DeviceState.AUTO:
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      case DeviceState.MANUAL:
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case DeviceState.OFF:
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  async handleTargetHeatingCoolingStateSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    const deviceId = this.accessory.context.device.id;
    const serviceId = BoschServiceId.RoomClimateControl;

    const roomControlModeState = {
      '@type': 'climateControlState',
    };

    const operationModeState = {
      '@type': 'climateControlState',
    };

    switch(value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        operationModeState['operationMode'] = BoschOperationMode.AUTOMATIC;
        roomControlModeState['roomControlMode'] = BoschRoomControlMode.HEATING;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        operationModeState['operationMode'] = BoschOperationMode.MANUAL;
        roomControlModeState['roomControlMode'] = BoschRoomControlMode.HEATING;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        roomControlModeState['roomControlMode'] = BoschRoomControlMode.OFF;
        break;
      default:
        throw new Error('Unknown target heating cooling state');
    }

    await lastValueFrom(
      this.platform.bshb
        .getBshcClient()
        .putState(this.getPath(deviceId, serviceId), roomControlModeState)
        .pipe(
          concatMap(response => iif(
            () => operationModeState['operationMode'] != null,
            this.platform.bshb
              .getBshcClient()
              .putState(this.getPath(deviceId, serviceId), operationModeState),
            of(response),
          ))),
    );
  }

  async handleCurrentTemperatureGet(): Promise<number> {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const state = await lastValueFrom(this.updateLocalState());
    return state.currentTemperature;
  }

  async handleTargetTemperatureGet(): Promise<number> {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const state = await lastValueFrom(this.updateLocalState());
    return state.targetTemperature;
  }

  async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    const deviceId = this.accessory.context.device.id;
    const serviceId = BoschServiceId.RoomClimateControl;

    const state: Partial<BoschClimateControlState> = {
      '@type': 'climateControlState',
      setpointTemperature: Number(value),
    };

    await lastValueFrom(
      this.platform.bshb
        .getBshcClient()
        .putState(this.getPath(deviceId, serviceId), state),
    );
  }

  async handleTemperatureDisplayUnitsGet(): Promise<number> {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  async handleTemperatureDisplayUnitsSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('Triggered SET TemperatureDisplayUnits:', value);
  }
}
