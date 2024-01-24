import { lastValueFrom, concatMap, switchMap, from, filter, map, toArray } from 'rxjs';
import { BoschSmartHomeBridge, BshbResponse } from 'bosch-smart-home-bridge';
import {
  BoschClimateControlState,
  BoschDevice,
  BoschDeviceServiceData,
  BoschOperationMode,
  BoschRoom,
  BoschRoomControlMode,
  BoschServiceId,
} from './types';

export class BshcApi {

  private readonly bshb: BoschSmartHomeBridge;

  constructor(bshb: BoschSmartHomeBridge) {
    this.bshb = bshb;
  }

  getServicePath(deviceId: string, serviceId: BoschServiceId): string {
    return `devices/${deviceId}/services/${serviceId}`;
  }

  pair(clientName: string, clientId: string, systemPassword: string) {
    return lastValueFrom(
      this.bshb.pairIfNeeded(clientName, clientId, systemPassword),
    );
  }

  subscribe() {
    return lastValueFrom(this.bshb
      .getBshcClient()
      .subscribe()
      .pipe(map(response => {
        return response.parsedResponse.result;
      })),
    );
  }

  unsubscribe(longPollingId: string) {
    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .unsubscribe(longPollingId),
    );
  }

  poll(longPollingId: string) {
    return lastValueFrom(this.bshb
      .getBshcClient()
      .longPolling(longPollingId)
      .pipe(map((response) => {
        return response.parsedResponse.result;
      })),
    );
  }

  getDevices() {
    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .getDevices()
        .pipe(
          concatMap((response: BshbResponse<BoschDevice[]>) => {
            const devices = response.parsedResponse;
            return from(devices);
          }), filter(device => {
            const deviceServiceIds = Object.values(device.deviceServiceIds);

            return deviceServiceIds?.includes(BoschServiceId.RoomClimateControl)
            && deviceServiceIds?.includes(BoschServiceId.TemperatureLevel);
          }),
          toArray(),
        ),
    );
  }

  getServiceData(deviceId: string) {
    return lastValueFrom(
      this.bshb.getBshcClient().getDeviceServices(deviceId, 'all')
        .pipe(
          switchMap((response: BshbResponse<BoschDeviceServiceData[]>) => {
            return from(response.parsedResponse);
          }),
          toArray(),
        ),
    );
  }

  getRoom(roomId: string) {
    return lastValueFrom(
      this.bshb.getBshcClient().getRoom(roomId)
        .pipe(
          map((response: BshbResponse<BoschRoom>) => {
            return response.parsedResponse;
          }),
        ),
    );
  }

  setTargetTemperature(deviceId: string, temperature: number) {
    const serviceId = BoschServiceId.RoomClimateControl;
    const deviceServicePath = this.getServicePath(deviceId, serviceId);

    const climateControlState: Partial<BoschClimateControlState> = {
      '@type': 'climateControlState',
      setpointTemperature: temperature,
    };

    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .putState(
          deviceServicePath,
          climateControlState,
        ),
    );
  }

  setHeatingOff(deviceId: string) {
    const serviceId = BoschServiceId.RoomClimateControl;
    const deviceServicePath = this.getServicePath(deviceId, serviceId);

    const roomControlModeState = {
      '@type': 'climateControlState',
      roomControlMode: BoschRoomControlMode.OFF,
    };

    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .putState(
          deviceServicePath,
          roomControlModeState,
        ),
    );
  }

  setHeatingAuto(deviceId: string) {
    const serviceId = BoschServiceId.RoomClimateControl;
    const deviceServicePath = this.getServicePath(deviceId, serviceId);

    const roomControlModeState = {
      '@type': 'climateControlState',
      roomControlMode: BoschRoomControlMode.HEATING,
    };

    const operationModeState = {
      '@type': 'climateControlState',
      operationMode: BoschOperationMode.AUTOMATIC,
    };

    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .putState(
          deviceServicePath,
          roomControlModeState,
        ),
    ).then(() => {
      return lastValueFrom(
        this.bshb
          .getBshcClient()
          .putState(
            deviceServicePath,
            operationModeState,
          ),
      );
    });
  }

  setHeatingManual(deviceId: string) {
    const serviceId = BoschServiceId.RoomClimateControl;
    const deviceServicePath = this.getServicePath(deviceId, serviceId);

    const roomControlModeState = {
      '@type': 'climateControlState',
      roomControlMode: BoschRoomControlMode.HEATING,
    };

    const operationModeState = {
      '@type': 'climateControlState',
      operationMode: BoschOperationMode.MANUAL,
    };

    return lastValueFrom(
      this.bshb
        .getBshcClient()
        .putState(
          deviceServicePath,
          roomControlModeState,
        ),
    ).then(() => {
      return lastValueFrom(
        this.bshb
          .getBshcClient()
          .putState(
            deviceServicePath,
            operationModeState,
          ),
      );
    });
  }
}