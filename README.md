# homebridge-bosch-room-climate-control

This [Homebridge](https://github.com/homebridge/homebridge) plugin implements **room climate control** in HomeKit through a **virtual thermostat**. Events from the Bosch Smart Home Controller (BSHC) are consumed via long polling, which means that all **changes** also from outside of HomeKit (e.g., physical control of a room thermostat or radiator thermostat, updates made via the Bosch Smart Home App, a change of the room temperature, etc.) are **immediately reflected** and updated **in HomeKit**, without a manual refresh or accessory update.

> Note: This plugin has only been tested manually with Radiator Thermostats II and is at an early stage where unexpected behavior may occur

## Why not use the built-in HomeKit integration?

The official and built-in HomeKit integration for Bosch Smart Home thermostats is functionally limited. Currently it is not possible to control thermostats that are grouped into a room (room climate control), to switch between manual and automatic mode, or to turn the heating on and off.

## Getting started

1. Generate an OpenSSL key pair (see the [API docs of the BSHC](https://github.com/BoschSmartHome/bosch-shc-api-docs/tree/master/postman) for more details)
```sh
openssl req -x509 -nodes -days 9999 -newkey rsa:2048 -keyout client-key.pem -out client-cert.pem
```
2. Encode your system password
```sh
echo -n 'secret' | openssl base64
```
3. Set the contents of the certificate and key, the encoded system password, the IP address of the BSHC, and other configuration options as shown in [`.homebridge/config.example.json`](.homebridge/config.example.json) via the Homebridge UI (or by creating a `.homebridge/config.json` file).
4. Press the pair button on the BSHC before starting the plugin for the first time

## Settings

See [`config.schema.json`](config.schema.json)

## Credits

- [bosch-smart-home-bridge](https://github.com/holomekc/bosch-smart-home-bridge) (API client)
- [Bosch Smart Home Controller Local API](https://github.com/BoschSmartHome/bosch-shc-api-docs) (API documentation)

## Contributing

Please consider opening a PR if you have suggestions for improvements or spot a potential bug

