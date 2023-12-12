import { Observable, switchMap, from, map, filter, lastValueFrom, iif, of, concatMap } from 'rxjs';
import { Service, PlatformAccessory, Characteristic, CharacteristicValue } from 'homebridge';

import * as packageJson from './package.json';

import {
  AccessoryContext,
  BoschDeviceServiceData,
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

  private timeoutId!: NodeJS.Timeout;

  public get type(): typeof Service.Thermostat {
    return this.platform.Service.Thermostat;
  }

  public get service(): Service {
    return this.platformAccessory.getService(this.type) || this.platformAccessory.addService(this.type);
  }

  constructor(
        readonly platform: BoschRoomClimateControlPlatform,
        readonly platformAccessory: PlatformAccessory<AccessoryContext>,
  ) {
    this.platform.log.info(`Creating accessory ${this.platformAccessory.displayName}...`);

    this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, platformAccessory.context.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, platformAccessory.context.device.deviceModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, platformAccessory.context.device.serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, packageJson.version);

    this.registerHandlers();
  }

  public dispose() {
    this.cancelPeriodicUpdates();
  }

  public getPath(deviceId: string, serviceId: BoschServiceId): string {
    return `devices/${deviceId}/services/${serviceId}`;
  }

  public getLocalState(): AccessoryState {
    return { ...this.state };
  }

  public handleDeviceServiceDataUpdate(deviceServiceData: BoschDeviceServiceData): void {
    this.setLocalStateFromDeviceServiceData(deviceServiceData);

    const state = this.getLocalState();
    this.updateCharacteristicStateWitAccessoryState(state, deviceServiceData);
  }

  private async initializeState(): Promise<AccessoryState> {
    return lastValueFrom(this.updateLocalState());
  }

  private async startPeriodicUpdates(): Promise<void> {
    const minutes = this.platform.config.periodicUpdates;

    if (minutes == null || minutes < 1) {
      this.platform.log.debug('Periodic updates are disabled');
      return;
    }

    this.timeoutId = setTimeout(async () => {
      await this.initializeState();
      this.startPeriodicUpdates();
    }, minutes * 60 * 1000);
  }

  private cancelPeriodicUpdates(): void {
    clearTimeout(this.timeoutId);
  }

  private async registerHandlers(): Promise<void> {
    await this.initializeState();

    this.startPeriodicUpdates();

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

  private isRoomClimateControlService(deviceServiceData: BoschDeviceServiceData)
  : deviceServiceData is BoschDeviceServiceData<BoschClimateControlState> {
    if (deviceServiceData.id === BoschServiceId.RoomClimateControl) {
      return true;
    }

    return false;
  }

  private isTemperatureLevelService(deviceServiceData: BoschDeviceServiceData)
  : deviceServiceData is BoschDeviceServiceData<BoschTemperatureLevelState> {
    if (deviceServiceData.id === BoschServiceId.TemperatureLevel) {
      return true;
    }

    return false;
  }

  private updateLocalState(): Observable<AccessoryState> {
    return this.platform.bshb.getBshcClient().getDeviceServices(this.platformAccessory.context.device.id, 'all')
      .pipe(
        switchMap((response: BshbResponse<BoschDeviceServiceData[]>) => {
          this.platform.log.debug(
            `Found ${(response.parsedResponse.length)} services for device ${this.platformAccessory.context.device.id}`,
          );

          return from(response.parsedResponse);
        }), filter(deviceServiceData => {
          return deviceServiceData.id === BoschServiceId.RoomClimateControl
        || deviceServiceData.id === BoschServiceId.TemperatureLevel;
        }), map(deviceServiceData => {
          this.setLocalStateFromDeviceServiceData(deviceServiceData);
          return this.getLocalState();
        }),
      );
  }

  private setLocalStateFromDeviceServiceData(deviceServiceData: BoschDeviceServiceData): void {
    if (this.isRoomClimateControlService(deviceServiceData)) {
      this.state.deviceState = this.extractDeviceState(deviceServiceData.state);
      this.state.targetTemperature = deviceServiceData.state.setpointTemperature;
    }

    if (this.isTemperatureLevelService(deviceServiceData)) {
      this.state.currentTemperature = this.extractCurrentTemperature(deviceServiceData.state);
    }
  }

  private updateCharacteristicStateWitAccessoryState(state: AccessoryState, deviceServiceData?: BoschDeviceServiceData) {
    if (deviceServiceData == null || this.isRoomClimateControlService(deviceServiceData)) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, state.targetTemperature);

      const targetHeatingCoolingState = this.getTargetHeatingCoolingStateFromState(state);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetHeatingCoolingState);

      const currentHeatingCoolingState = this.getCurrentHeatingCoolingStateFromState(state);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentHeatingCoolingState);
    }

    if (deviceServiceData == null || this.isTemperatureLevelService(deviceServiceData)) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, state.currentTemperature);
    }
  }

  private extractDeviceState(state: BoschClimateControlState): DeviceState {
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

  private extractCurrentTemperature(state: BoschTemperatureLevelState): number {
    return state.temperature;
  }

  private getCurrentHeatingCoolingStateFromState(state: AccessoryState): keyof SupportedCurrentHeatingCoolingState {
    if (state.deviceState === DeviceState.OFF) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    if (state.currentTemperature > state.targetTemperature) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
  }

  private getTargetHeatingCoolingStateFromState(state: AccessoryState): keyof SupportedTargetHeatingCoolingState {
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

  private async handleCurrentHeatingCoolingStateGet(): Promise<keyof SupportedCurrentHeatingCoolingState> {
    this.platform.log.debug('Triggered GET CurrentHeatingCoolingState');

    // const state = await lastValueFrom(this.updateLocalState());
    const state = this.getLocalState();
    return this.getCurrentHeatingCoolingStateFromState(state);
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<keyof SupportedTargetHeatingCoolingState> {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    // const state = await lastValueFrom(this.updateLocalState());
    const state = this.getLocalState();
    return this.getTargetHeatingCoolingStateFromState(state);
  }

  private async handleTargetHeatingCoolingStateSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    const deviceId = this.platformAccessory.context.device.id;
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

    // TODO: remove manual update with long polling implementation
    // const state = await lastValueFrom(this.updateLocalState());
    // this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, state.targetTemperature);
  }

  private async handleCurrentTemperatureGet(): Promise<number> {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    // const state = await lastValueFrom(this.updateLocalState());
    const state = this.getLocalState();
    return state.currentTemperature;
  }

  private async handleTargetTemperatureGet(): Promise<number> {
    this.platform.log.debug('Triggered GET TargetTemperature');

    // const state = await lastValueFrom(this.updateLocalState());
    const state = this.getLocalState();
    return state.targetTemperature;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    const deviceId = this.platformAccessory.context.device.id;
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

  private async handleTemperatureDisplayUnitsGet(): Promise<number> {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  private async handleTemperatureDisplayUnitsSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('Triggered SET TemperatureDisplayUnits:', value);
  }
}
