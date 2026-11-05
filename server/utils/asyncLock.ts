import { EventEmitter } from 'events';

// Wrap any "get existing / create if missing / save" sequence for a movie or
// show in asyncLock.dispatch keyed on media id, so only one runs at a time per
// id and duplicate entries (unique constraint failures) can't be created.

class AsyncLock {
  private locked: { [key: string]: boolean } = {};
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  private acquire = async (key: string) => {
    return new Promise((resolve) => {
      if (!this.locked[key]) {
        this.locked[key] = true;
        return resolve(undefined);
      }

      const nextAcquire = () => {
        if (!this.locked[key]) {
          this.locked[key] = true;
          this.ee.removeListener(key, nextAcquire);
          return resolve(undefined);
        }
      };

      this.ee.on(key, nextAcquire);
    });
  };

  private release = (key: string): void => {
    delete this.locked[key];
    setImmediate(() => this.ee.emit(key));
  };

  public dispatch = async <T>(
    key: string | number,
    callback: () => Promise<T>
  ): Promise<T> => {
    const skey = String(key);
    await this.acquire(skey);
    try {
      return await callback();
    } finally {
      this.release(skey);
    }
  };
}

export default AsyncLock;
