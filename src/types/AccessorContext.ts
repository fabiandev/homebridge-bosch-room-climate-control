import { BoschDevice } from './BoschDevice';
import { BoschRoom } from './BoschRoom';

export type AccessoryContext = {
    device: BoschDevice;
    room: BoschRoom;
};
