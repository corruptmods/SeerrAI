import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

/**
 * useState plus a debounced copy of the value.
 *
 * @param debounceTime Debounce time in ms
 */
const useDebouncedState = <S>(
  initialValue: S,
  debounceTime = 300
): [S, S, Dispatch<SetStateAction<S>>] => {
  const [value, setValue] = useState(initialValue);
  const [finalValue, setFinalValue] = useState(initialValue);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setFinalValue(value);
    }, debounceTime);

    return () => {
      clearTimeout(timeout);
    };
  }, [value, debounceTime]);

  return [value, finalValue, setValue];
};

export default useDebouncedState;
