import { Service, PlatformAccessory, Characteristic, CharacteristicValue, Logger, HAPStatus } from 'homebridge';
import { BshbError, BshbErrorType } from 'bosch-smart-home-bridge';

import * as packageJson from './package.json';
import { BoschRoomClimateControlPlatform } from './platform';
import { BoschClimateControlState } from './types/BoschClimateControlState';
import { pretty } from './utils';

import {
  AccessoryContext,
  BoschDeviceServiceData,
  BoschOperationMode,
  BoschRoomControlMode,
  BoschTemperatureLevelState,
  BoschDevice,
  isRoomClimateControlService,
  isTemperatureLevelService,
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
    this.stopPeriodicStateSync();
  }

  public getDeviceContext(): BoschDevice {
    return this.platformAccessory.context.device;
  }

  public getPlatformAccessory(): PlatformAccessory<AccessoryContext> {
    return this.platformAccessory;
  }

  public getDeviceId(): string {
    return this.getDeviceContext().id;
  }

  public getLocalState(): AccessoryState {
    return { ...this.state };
  }

  public setUnavailable(): void {
    this.log.warn('Setting accessory to unavailable...');

    this.state.available = false;

    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      new Error('Current state unavailable'),
    );
  }

  public onBoschEvent(deviceServiceData: BoschDeviceServiceData): void {
    try {
      this.updateLocalState(deviceServiceData);
      this.updateCharacteristics(this.getLocalState());
    } catch(e) {
      this.setUnavailable();
    }
  }

  private async registerHandlers(): Promise<void> {
    this.log.info('Initializing accessory...');

    await this.syncAccessory();

    this.log.info('Starting periodic state updates...');
    this.startPeriodicStateSync();

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

  private async syncAccessory(): Promise<void> {
    this.log.info('Updating state...');

    return this.platform.queue.add(async () => {
      const deviceId = this.getDeviceId();

      try {
        (await this.platform.bshcApi.getServiceData(deviceId))
          .forEach(data => {
            this.updateLocalState(data);
          });
      } catch(e) {
        this.log.warn('Could not fetch device state');
        this.setUnavailable();
        return;
      }

      if (this.state.currentTemperature == null) {
        this.log.warn('Current temperature is not available');
        this.setUnavailable();
        return;
      }

      this.updateCharacteristics(this.getLocalState());
    });
  }

  private startPeriodicStateSync(): void {
    const minutes = this.platform.config.stateSyncFrequency ??
      this.platform.config.stateUpdateFrequency ??
      this.platform.config.stateUpdates;

    if (minutes == null || minutes < 1) {
      this.log.info('Periodic updates are disabled');
      return;
    }

    this.timeoutId = setTimeout(async () => {
      this.log.debug('Running periodic state update...');

      try {
        await this.syncAccessory();
      } catch(e) {
        this.log.warn(`Could not update state during periodic update, retrying during next cycle in ${minutes} minutes`, e);
      }

      this.startPeriodicStateSync();
    }, minutes * 60 * 1000);
  }

  private stopPeriodicStateSync(): void {
    if (this.timeoutId == null) {
      return;
    }

    this.log.info('Stopping periodic state updates...');
    clearTimeout(this.timeoutId);
  }

  private updateLocalState(deviceServiceData: BoschDeviceServiceData): void {
    this.state.available = true;

    this.log.debug(`Attempting to set local state from device service data ${deviceServiceData.id}...`);

    if (isRoomClimateControlService(deviceServiceData)) {
      this.log.debug('Setting local state from room climate control device service data...');

      this.state.deviceState = this.extractDeviceState(deviceServiceData.state);
      this.state.targetTemperature = deviceServiceData.state.setpointTemperature;
    }

    if (isTemperatureLevelService(deviceServiceData)) {
      this.log.debug('Setting local state from temperature level device service data...');

      const currentTemperature = this.extractCurrentTemperature(deviceServiceData.state);
      this.state.currentTemperature = currentTemperature;
    }
  }

  private updateCharacteristics(state: AccessoryState) {
    this.log.debug('Attempting to update characteristic with state...');
    this.log.debug(pretty(state));

    const targetTemperature = state.targetTemperature;
    if (targetTemperature !== this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).value) {
      this.log.debug(`Updating target temperature to ${state.targetTemperature}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemperature);
    }

    const targetHeatingCoolingState = this.getTargetHeatingCoolingState(state);
    if (targetHeatingCoolingState !== this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).value) {
      this.log.debug(`Updating target heating cooling state to ${targetHeatingCoolingState}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetHeatingCoolingState);
    }

    const currentHeatingCoolingState = this.getCurrentHeatingCoolingState(state);
    if (currentHeatingCoolingState !== this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).value) {
      this.log.debug(`Updating current heating cooling state to ${currentHeatingCoolingState}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentHeatingCoolingState);
    }

    const currentTemperature = state.currentTemperature;
    if (
      currentTemperature != null // Accessory is set to unavailable if current temperature is not available
      && currentTemperature !== this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature).value
    ) {
      this.log.debug(`Updating current temperature to ${state.currentTemperature}...`);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemperature);
    }
  }

  private async handleCurrentHeatingCoolingStateGet(): Promise<AccessoryCurrentHeatingCoolingState> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting current heating cooling state...');

    const state = this.getLocalState();
    return this.getCurrentHeatingCoolingState(state);
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<AccessoryTargetHeatingCoolingState> {
    this.throwErrorIfUnavailable();

    this.log.debug('Getting target heating cooling state...');

    const state = this.getLocalState();
    return this.getTargetHeatingCoolingState(state);
  }

  private async handleTargetHeatingCoolingStateSet(value: CharacteristicValue): Promise<void> {
    await this.platform.queue.add(async () => {
      this.throwErrorIfUnavailable();

      this.log.debug('Setting target heating cooling state...', value);

      const deviceId = this.getDeviceId();

      try {
        switch(value) {
          case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
            await this.platform.bshcApi.setHeatingAuto(deviceId);
            return;
          case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
            await this.platform.bshcApi.setHeatingManual(deviceId);
            return;
          case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
            await this.platform.bshcApi.setHeatingOff(deviceId);
            return;
        }
      } catch(e) {
        this.throwHapStatusError(e as BshbError);
      }

      this.log.warn(`Unsupported target heating cooling state ${value}`);

      throw new this.platform.api.hap.HapStatusError(
        HAPStatus.INVALID_VALUE_IN_REQUEST,
      );
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
        this.log.warn('Cannot set target temperature while room control mode is set to off');

        throw new this.platform.api.hap.HapStatusError(
          HAPStatus.INVALID_VALUE_IN_REQUEST,
        );
      }

      if (value == null) {
        this.log.debug('No value provided for target temperature');

        throw new this.platform.api.hap.HapStatusError(
          HAPStatus.INVALID_VALUE_IN_REQUEST,
        );
      }

      const deviceId = this.getDeviceId();

      try {
        await this.platform.bshcApi.setTargetTemperature(deviceId, +value);
      } catch(e) {
        this.throwHapStatusError(e as BshbError);
      }
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

    if(value !== this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS) {
      this.log.error(`Unsupported temperature display unit ${value}`);

      throw new this.platform.api.hap.HapStatusError(
        HAPStatus.INVALID_VALUE_IN_REQUEST,
      );
    }
  }

  private extractDeviceState(boschState: BoschClimateControlState): DeviceState {
    if (boschState.roomControlMode === BoschRoomControlMode.OFF) {
      return DeviceState.OFF;
    }

    if (boschState.operationMode === BoschOperationMode.AUTOMATIC) {
      return DeviceState.AUTO;
    }

    if (boschState.operationMode === BoschOperationMode.MANUAL) {
      return DeviceState.MANUAL;
    }

    return DeviceState.OFF;
  }

  private extractCurrentTemperature(boschState: BoschTemperatureLevelState): number {
    return boschState.temperature;
  }

  private getCurrentHeatingCoolingState(state: AccessoryState) {
    if (state.deviceState === DeviceState.OFF) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    if (state.currentTemperature > state.targetTemperature) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
  }

  private getTargetHeatingCoolingState(state: AccessoryState): AccessoryTargetHeatingCoolingState {
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

  private throwErrorIfUnavailable() {
    if (this.state.available) {
      return;
    }

    this.log.warn('Accessory not available');

    throw new this.platform.api.hap.HapStatusError(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  private throwHapStatusError(error: BshbError): void {
    const e = error as BshbError;
    this.log.error(e.message);

    switch (e.errorType) {
      case BshbErrorType.TIMEOUT:
        throw new this.platform.api.hap.HapStatusError(
          HAPStatus.OPERATION_TIMED_OUT,
        );
      case BshbErrorType.PARSING:
        throw new this.platform.api.hap.HapStatusError(
          HAPStatus.INVALID_VALUE_IN_REQUEST,
        );
      default:
        throw new this.platform.api.hap.HapStatusError(
          HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
    }
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
}
