import { switchMap, from, map, filter, lastValueFrom, iif, of, concatMap } from 'rxjs';
import { Service, PlatformAccessory } from 'homebridge';

import { BoschRoomClimateControlPlatform } from './platform';
import {
  Context, Service as BoschService, ServiceId as BoschServiceId, OperationMode, RoomControlMode, TemperatureLevelState,
} from './types';
import { BshbResponse } from 'bosch-smart-home-bridge';
import { ClimateControlState } from './types/ClimateControlState';

enum DeviceState {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
  OFF = 'OFF',
}

type AccessoryState = {
  currentTemperature: number;
  targetTemperature: number;
  deviceState: DeviceState;
};

export class BoschRoomClimateControlAccessory {
  private state: AccessoryState = {
    currentTemperature: 0,
    targetTemperature: 5,
    deviceState: DeviceState.OFF,
  };

  get service(): Service {
    return this.accessory.getService(this.type) || this.accessory.addService(this.type);
  }

  get type() {
    return this.platform.Service.Thermostat;
  }

  constructor(
        private readonly platform: BoschRoomClimateControlPlatform,
        private readonly accessory: PlatformAccessory<Context>,
  ) {
    this.platform.log.info(`Creating accessory ${this.accessory.displayName}...`);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.deviceModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.serial);
    // .setCharacteristic(this.platform.Characteristic.FirmwareRevision, packageJson.version);

    this.registerHandlers();
  }

  registerHandlers() {
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

  updateLocalState() {
    return this.platform.bshb.getBshcClient().getDeviceServices(this.accessory.context.device.id, 'all')
      .pipe(
        switchMap((response: BshbResponse<BoschService[]>) => {
          this.platform.log.debug(`Found ${(response.parsedResponse.length)} services for device ${this.accessory.context.device.id}`);
          return from(response.parsedResponse);
        }), filter(service => {
          return service.id === BoschServiceId.RoomClimateControl
        || service.id === BoschServiceId.TemperatureLevel;
        }), map(service => {
          if (service.id === BoschServiceId.RoomClimateControl) {
            this.state.deviceState = this.extractDeviceState(<ClimateControlState>service.state);
            this.state.targetTemperature = (service.state as ClimateControlState).setpointTemperature;
          }

          if (service.id === BoschServiceId.TemperatureLevel) {
            this.state.currentTemperature = this.extractCurrentTemperature(<TemperatureLevelState>service.state);
          }

          return this.state;
        }),
      );
  }

  extractDeviceState(state: ClimateControlState) {
    if (state.roomControlMode === RoomControlMode.OFF) {
      return DeviceState.OFF;
    }

    if (state.operationMode === OperationMode.AUTOMATIC) {
      return DeviceState.AUTO;
    }

    if (state.operationMode === OperationMode.MANUAL) {
      return DeviceState.MANUAL;
    }

    return DeviceState.OFF;
  }

  extractCurrentTemperature(state: TemperatureLevelState): number {
    return state.temperature;
  }

  getPath(deviceId: string, serviceId: BoschServiceId) {
    return `devices/${deviceId}/services/${serviceId}`;
  }

  async handleCurrentHeatingCoolingStateGet() {
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

  async handleTargetHeatingCoolingStateGet() {
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

  async handleTargetHeatingCoolingStateSet(value) {
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
        operationModeState['operationMode'] = OperationMode.AUTOMATIC;
        roomControlModeState['roomControlMode'] = RoomControlMode.HEATING;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        operationModeState['operationMode'] = OperationMode.MANUAL;
        roomControlModeState['roomControlMode'] = RoomControlMode.HEATING;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        roomControlModeState['roomControlMode'] = RoomControlMode.OFF;
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

  async handleCurrentTemperatureGet() {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const state = await lastValueFrom(this.updateLocalState());
    return state.currentTemperature;
  }

  async handleTargetTemperatureGet() {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const state = await lastValueFrom(this.updateLocalState());
    return state.targetTemperature;
  }

  async handleTargetTemperatureSet(value) {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    const deviceId = this.accessory.context.device.id;
    const serviceId = BoschServiceId.RoomClimateControl;

    const state = {
      '@type': 'climateControlState',
      setpointTemperature: value,
    };

    await lastValueFrom(
      this.platform.bshb
        .getBshcClient()
        .putState(this.getPath(deviceId, serviceId), state),
    );
  }

  async handleTemperatureDisplayUnitsGet() {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  async handleTemperatureDisplayUnitsSet(value) {
    this.platform.log.debug('Triggered SET TemperatureDisplayUnits:', value);
    return Promise.resolve();
  }
}
