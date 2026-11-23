import OverrideRule from '@server/entity/OverrideRule';
import { refreshAnimeRules } from '@server/lib/animeRules';
import type {
  EntitySubscriberInterface,
  InsertEvent,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber } from 'typeorm';

/** A rule was written in a transaction not yet over. */
let written = false;

/**
 * Keeps auto anime handling (Settings.animeOn) in step with the override
 * rules: a rule naming TMDB's anime keyword or setting the anime series type
 * turns it on. Read again with the writer's manager, so the write is seen,
 * and again if its transaction rolls back.
 */
@EventSubscriber()
export class OverrideRuleSubscriber implements EntitySubscriberInterface<OverrideRule> {
  public listenTo(): typeof OverrideRule {
    return OverrideRule;
  }

  private async changed(
    event:
      | InsertEvent<OverrideRule>
      | UpdateEvent<OverrideRule>
      | RemoveEvent<OverrideRule>
  ): Promise<void> {
    written = true;
    await refreshAnimeRules(event.manager);
  }

  public afterInsert(event: InsertEvent<OverrideRule>): Promise<void> {
    return this.changed(event);
  }

  public afterUpdate(event: UpdateEvent<OverrideRule>): Promise<void> {
    return this.changed(event);
  }

  public afterRemove(event: RemoveEvent<OverrideRule>): Promise<void> {
    return this.changed(event);
  }

  public afterTransactionCommit(): void {
    written = false;
  }

  public async afterTransactionRollback(): Promise<void> {
    if (written) {
      written = false;
      await refreshAnimeRules();
    }
  }
}
