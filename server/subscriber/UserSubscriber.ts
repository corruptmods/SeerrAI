import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { usersChanged } from '@server/lib/sessionUser';
import type {
  EntitySubscriberInterface,
  InsertEvent,
  RecoverEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber } from 'typeorm';

type WriteEvent =
  | InsertEvent<unknown>
  | UpdateEvent<unknown>
  | RemoveEvent<unknown>
  | SoftRemoveEvent<unknown>
  | RecoverEvent<unknown>;

const onUsers = (event: WriteEvent): void => {
  if (
    event.metadata.target === User ||
    event.metadata.target === UserSettings
  ) {
    usersChanged();
  }
};

/**
 * Keeps shared user reads (lib/sessionUser) from outliving a change. Hears
 * every entity: writes to users count at once, and every transaction's end
 * counts too, since a read made inside one, or before its commit, may differ
 * from what is in the database after.
 */
@EventSubscriber()
export class UserSubscriber implements EntitySubscriberInterface {
  public afterInsert(event: InsertEvent<unknown>): void {
    onUsers(event);
  }

  public afterUpdate(event: UpdateEvent<unknown>): void {
    onUsers(event);
  }

  public afterRemove(event: RemoveEvent<unknown>): void {
    onUsers(event);
  }

  public afterSoftRemove(event: SoftRemoveEvent<unknown>): void {
    onUsers(event);
  }

  public afterRecover(event: RecoverEvent<unknown>): void {
    onUsers(event);
  }

  public afterTransactionCommit(): void {
    usersChanged();
  }

  public afterTransactionRollback(): void {
    usersChanged();
  }
}
