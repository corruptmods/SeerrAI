export enum ApiErrorCode {
  InvalidUrl = 'INVALID_URL',
  InvalidCredentials = 'INVALID_CREDENTIALS',
  InvalidAuthToken = 'INVALID_AUTH_TOKEN',
  InvalidEmail = 'INVALID_EMAIL',
  NotAdmin = 'NOT_ADMIN',
  NoAdminUser = 'NO_ADMIN_USER',
  ConnectionError = 'CONNECTION_ERROR',
  SyncErrorGroupedFolders = 'SYNC_ERROR_GROUPED_FOLDERS',
  SyncErrorNoLibraries = 'SYNC_ERROR_NO_LIBRARIES',
  InvalidNetworkList = 'INVALID_NETWORK_LIST',
  TooManyNetworks = 'TOO_MANY_NETWORKS',
  Unauthorized = 'UNAUTHORIZED',
  /**
   * A media server account new here whose email or name belongs to an existing
   * account: its owner signs in with that account and links the server from
   * their profile.
   */
  ExistingAccount = 'EXISTING_ACCOUNT',
  /** The media server account is disabled there. */
  AccountDisabled = 'ACCOUNT_DISABLED',
  Unknown = 'UNKNOWN',
}
