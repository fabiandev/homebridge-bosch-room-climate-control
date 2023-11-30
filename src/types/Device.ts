import { Status, Service } from './';

export type Device = {
    '@type': 'device';
    'rootDeviceId': string;
    'id': string;
    'deviceServiceIds': Service[];
    'manufacturer': string;
    'roomId': string;
    'deviceModel': string;
    'serial': string;
    'profile': string;
    'name': string;
    'status': Status;
    'parentDeviceId'?: string;
    'childDeviceIds': [];
    'supportedProfiles': [];
};