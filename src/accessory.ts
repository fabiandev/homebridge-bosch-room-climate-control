import { switchMap, from, map, filter, lastValueFrom, toArray } from 'rxjs';
import { Service, PlatformAccessory, Characteristic, CharacteristicValue, Logger } from 'homebridge';
import { BshbResponse } from 'bosch-smart-home-bridge';

import * as packageJson from './package.json';
import { BoschRoomClimateControlPlatform } from './platform';
import { BoschClimateControlState } from './types/BoschClimateControlState';
import { pretty } from './utils';

import {
  AccessoryContext,
  BoschDeviceServiceData,
  BoschServiceId,
  BoschOperationMode,
  BoschRoomControlMode,
  BoschTemperatureLevelState,
  BoschDevice,
} from './types';

export enum DeviceState {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
  OFF = 'OFF',
}

export type AccessoryState = {
  available: boolean;
  currentTemperature: number;
  targetTemperature: number;
  deviceState: DeviceState;
};

type AccessoryCurrentHeatingCoolingState =
  typeof Characteristic.CurrentHeatingCoolingState.HEAT |
  typeof Characteristic.CurrentHeatingCoolingState.OFF;

type AccessoryTargetHeatingCoolingState =
  typeof Characteristic.TargetHeatingCoolingState.AUTO |
  typeof Characteristic.CurrentHeatingCoolingState.HEAT |
  typeof Characteristic.CurrentHeatingCoolingState.OFF;

export class BoschRoomClimateControlAccessory {
  private timeoutId!: NodeJS.Timeout;

  private state: AccessoryState = {
    available: true,
    currentTemperature: 0,
    targetTemperature: 5,
    deviceState: DeviceState.OFF,
  };

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
    this.log.info('Creating accessory...');

    this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, platformAccessory.context.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, platformAccessory.context.device.deviceModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, platformAccessory.context.device.serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, packageJson.version);

    this.registerHandlers();
  }

  public dispose(): void {
    this.log.info('Disposing accessory...');
    this.stopPeriodicStateUpdates();
  }

  public getDeviceServicePath(deviceId: string, serviceId: BoschServiceId): string {
    return `devices/${deviceId}/services/${serviceId}`;
  }

  public getDeviceContext(): BoschDevice {
    return this.platformAccessory.context.device;
  }

  public getLocalState(): AccessoryState {
    return { ...this.state };
  }

  public setUnavailable() {
    this.log.warn('Setting accessory to unavailable...');

    this.state.available = false;

    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState, new Error('Current state unavailable'),
    );
  }

  public handleDeviceServiceDataUpdate(deviceServiceData: BoschDeviceServiceData): void {
    this.setLocalStateFromDeviceServiceData(deviceServiceData);

    const state = this.getLocalState();
    this.updateCharacteristicStateWitAccessoryState(state, deviceServiceData);
  }

  private get log(): Logger {
    const prefix = `[${this.platformAccessory.displayName}]`;

    const logger = (method: string) => {
      return (message: string, ...parameters: any[]) => {
        return this.platform.log[method](`${prefix} ${message}`, ...parameters);
      };
    };

    return {
      debug: logger('debug'),
      info: logger('info'),
      warn: logger('warn'),
      log: logger('log'),
      error: logger('error'),
      prefix: `${this.platform.log.prefix} ${prefix}`,
    };
  }

  private async initializeState(): Promise<void> {
    this.log.info('Updating state...');

    return this.platform.queue.add(async () => {
      try {
        await this.updateLocalState();
      } catch(e) {
        this.log.warn('Could not fetch device state', e);
        this.setUnavailable();
      }
    });
  }

  private startPeriodicStateUpdates(): void {
    const minutes = this.platform.config.stateUpdateFrequency ?? this.platform.config.stateUpdates;

    if (minutes == null || minutes < 1) {
      this.log.info('Periodic updates are disabled');
      return;
    }

    this.timeoutId = setTimeout(async () => {
      this.log.debug('Running periodic state update...');

      try {
        await this.initializeState();
      } catch(e) {
        this.log.warn(`Could not update state during periodic update, retrying during next cycle in ${minutes} minutes`, e);
      }

      this.startPeriodicStateUpdates();
    }, minutes * 60 * 1000);
  }

  private stopPeriodicStateUpdates(): void {
    if (this.timeoutId == null) {
      return;
    }

    this.log.info('Stopping periodic state updates...');
    clearTimeout(this.timeoutId);
  }

  private async registerHandlers(): Promise<void> {
    this.log.info('Initializing accessory...');

    await this.initializeState();

    this.log.info('Starting periodic state updates...');
    this.startPeriodicStateUpdates();

    this.log.info('Registering characteristic handlers...');

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

  private async updateLocalState(): Promise<BoschDeviceServiceData[]> {
    return lastValueFrom(
      this.platform.bshb.getBshcClient().getDeviceServices(this.platformAccessory.context.device.id, 'all')
        .pipe(
          switchMap((response: BshbResponse<BoschDeviceServiceData[]>) => {
            this.log.debug(
              `Found ${(response.parsedResponse.length)} services for device with ID ${this.platformAccessory.context.device.id}`,
            );

            return from(response.parsedResponse);
          }), filter(deviceServiceData => {
            return deviceServiceData.id === BoschServiceId.RoomClimateControl
        || deviceServiceData.id === BoschServiceId.TemperatureLevel;
          }), map(deviceServiceData => {
            this.setLocalStateFromDeviceServiceData(deviceServiceData);
            return deviceServiceData;
          }),
          toArray(),
        ),
    );
  }

  private setLocalStateFromDeviceServiceData(deviceServiceData: BoschDeviceServiceData): void {
    this.state.available = true;

    this.log.debug('Attempting to set local state from device service data...');

    if (this.isRoomClimateControlService(deviceServiceData)) {
      this.log.debug('Setting local state from room climate control device service data...');

      this.state.deviceState = this.extractDeviceState(deviceServiceData.state);
      this.state.targetTemperature = deviceServiceData.state.setpointTemperature;
    }

    if (this.isTemperatureLevelService(deviceServiceData)) {
      this.log.debug('Setting local state from temperature level device service data...');

      const currentTemperature = this.extractCurrentTemperature(deviceServiceData.state);
      this.state.currentTemperature = currentTemperature;

      if (currentTemperature == null) {
        this.log.warn('No current temperature available in state update');
        this.setUnavailable();
      }
    }
  }

  private updateCharacteristicStateWitAccessoryState(state: AccessoryState, deviceServiceData?: BoschDeviceServiceData) {
    this.log.debug('Attempting to update characteristic with state...');
    this.log.debug(pretty(state));

    if (deviceServiceData == null || this.isRoomClimateControlService(deviceServiceData)) {
      this.log.debug(`Updating target temperature to ${state.targetTemperature}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, state.targetTemperature);

      const targetHeatingCoolingState = this.getTargetHeatingCoolingStateFromState(state);
      this.log.debug(`Updating target heating cooling state to ${targetHeatingCoolingState}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetHeatingCoolingState);

      const currentHeatingCoolingState = this.getCurrentHeatingCoolingStateFromState(state);
      this.log.debug(`Updating current heating cooling state to ${currentHeatingCoolingState}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentHeatingCoolingState);
    }

    if (deviceServiceData == null || this.isTemperatureLevelService(deviceServiceData)) {
      this.log.debug(`Updating current temperature to ${state.currentTemperature}...`);
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

  private getCurrentHeatingCoolingStateFromState(state: AccessoryState) {
    if (state.deviceState === DeviceState.OFF) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    if (state.currentTemperature > state.targetTemperature) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
  }

  private getTargetHeatingCoolingStateFromState(state: AccessoryState): AccessoryTargetHeatingCoolingState {
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

  private async handleCurrentHeatingCoolingStateGet(): Promise<AccessoryCurrentHeatingCoolingState> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting current heating cooling state...');

    const state = this.getLocalState();
    return this.getCurrentHeatingCoolingStateFromState(state);
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<AccessoryTargetHeatingCoolingState> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting target heating cooling state...');

    const state = this.getLocalState();
    return this.getTargetHeatingCoolingStateFromState(state);
  }

  private async handleTargetHeatingCoolingStateSet(value: CharacteristicValue): Promise<void> {
    this.throwErrorIfUnavailable();

    await this.platform.queue.add(async () => {
      this.log.debug('Setting target heating cooling state...', value);

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
          this.log.warn(`Unsupported target heating cooling state ${value}`);

          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
      }

      if (roomControlModeState['roomControlMode'] != null) {
        this.log.debug('Setting room control mode...', roomControlModeState['roomControlMode']);

        await lastValueFrom(
          this.platform.bshb
            .getBshcClient()
            .putState(this.getDeviceServicePath(deviceId, serviceId), roomControlModeState),
        );
      }

      if (operationModeState['operationMode'] != null) {
        this.log.debug('Setting operation mode...', operationModeState['operationMode']);

        await lastValueFrom(this.platform.bshb
          .getBshcClient()
          .putState(this.getDeviceServicePath(deviceId, serviceId), operationModeState),
        );
      }
    });
  }

  private async handleCurrentTemperatureGet(): Promise<number> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting current temperature...');

    const state = this.getLocalState();
    return state.currentTemperature;
  }

  private async handleTargetTemperatureGet(): Promise<number> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting target temperature...');

    const state = this.getLocalState();
    return state.targetTemperature;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    this.throwErrorIfUnavailable();

    await this.platform.queue.add(async () => {
      this.log.debug('Setting target temperature...', value);

      if (this.getLocalState().deviceState === DeviceState.OFF) {
        this.log.debug('Cannot set target temperature while room control mode is set to off');
        return;
      }

      if (value == null) {
        this.log.debug('No value provided for target temperature');
        return;
      }

      const deviceId = this.platformAccessory.context.device.id;
      const serviceId = BoschServiceId.RoomClimateControl;

      const state: Partial<BoschClimateControlState> = {
        '@type': 'climateControlState',
        setpointTemperature: Number(value),
      };

      await lastValueFrom(
        this.platform.bshb
          .getBshcClient()
          .putState(this.getDeviceServicePath(deviceId, serviceId), state),
      );
    });
  }

  private async handleTemperatureDisplayUnitsGet(): Promise<number> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting temperature display unit...');
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  private async handleTemperatureDisplayUnitsSet(value: CharacteristicValue): Promise<void> {
    this.throwErrorIfUnavailable();

    this.log.debug('Setting temperatur edisplay unit...', value);
  }

  private throwErrorIfUnavailable() {
    if (this.state.available) {
      return;
    }

    this.log.warn('Accessory not available');

    throw new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }
}
