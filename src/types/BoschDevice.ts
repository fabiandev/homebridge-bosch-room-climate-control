import { BoschStatus, BoschServiceId } from '.';

export type BoschDevice = {
    '@type': 'device';
    rootDeviceId: string;
    id: string;
    deviceServiceIds: BoschServiceId[];
    manufacturer: string;
    roomId: string;
    deviceModel: string;
    serial: string;
    profile: string;
    name: string;
    status: BoschStatus;
    parentDeviceId?: string;
    childDeviceIds: [];
    supportedProfiles: [];
};