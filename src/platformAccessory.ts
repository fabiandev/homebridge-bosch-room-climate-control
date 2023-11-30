import { Service, PlatformAccessory } from 'homebridge';

import { BoschRoomClimateControlPlatform } from './platform';

export class ExamplePlatformAccessory {
  constructor(
        private readonly platform: BoschRoomClimateControlPlatform,
        private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'BOSCH')
      .setCharacteristic(this.platform.Characteristic.Model, 'Virtual-Room-Climate-Control')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');
  }

  get service(): Service {
    return this.accessory.getService(this.type) || this.accessory.addService(this.type);
  }

  get type() {
    return this.platform.Service.Thermostat;
  }
}
