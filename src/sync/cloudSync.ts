export type {
  AvailableRoomInfo,
  CloudArchivedSessionDetail,
  CloudArchivedSessionSummary,
  CloudConnectionStatus,
  CloudParticipant,
  CloudRoomState,
  LiveScannerState,
  RoomDeltaPayload,
  SyncResult,
  TombstoneState,
} from './types';

export {
  buildRoomEndpointUrl,
  buildRoomInviteUrl,
  canonicalCountId,
  generateRoomCode,
  isRoomInviteUrl,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  parseRoomInviteUrl,
} from './firebaseKeys';

export {
  archiveSessionToCloud,
  checkRoomExistsInDb,
  coerceRemoteRoomState,
  fetchCloudArchivedSession,
  fetchRemoteUpdatedAt,
  generateUniqueRoomCode,
  listAvailableRoomsInDb,
  listCloudArchivedSessions,
  patchRemoteRoomDelta,
  registerRoomInDbIndex,
  testFirebaseConnection,
} from './firebaseTransport';

export {
  getCachedRoomState,
  getCloudConnectionStatus,
  onCloudRoomUpdate,
  onCloudStatusChange,
} from './roomMirror';

export {
  computeDataFingerprint,
  computeStateFingerprint,
  getLocalTombstones,
  mergeRoomStates,
  recordTombstone,
  saveLocalTombstones,
} from './roomMerge';

export {
  decodeCompactCountQr,
  encodeCompactCountQrChunks,
  isCompactCountQr,
} from './compactQr';

export {
  _clearMemoryRooms,
  applyIncomingRoomStateToLocal,
  consumeUrlSyncParams,
  joinRoomFromInvite,
  publishLiveScannerState,
  startLiveCloudSync,
  stopLiveCloudSync,
  syncCatalogWithDb,
  syncDeltaToRemote,
  syncNow,
  triggerBackgroundSync,
} from './liveSyncEngine';
