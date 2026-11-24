import {
  refreshIntervalHelper,
  watchRequest,
} from '@app/utils/refreshIntervalHelper';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { useEffect } from 'react';
import useSWR from 'swr';

type Request = NonFunctionProperties<MediaRequest>;

/**
 * A request shown in a list or slider, kept live while in view and in
 * progress. The list just fetched it, so a row doesn't fetch it again on
 * mount, focus or reconnect (the list refreshes then); each newer copy the
 * list brings replaces the cached one, so a row never shows an older copy
 * another page left behind.
 */
const useLiveRequest = (request: Request, inView: boolean) => {
  const swr = useSWR<Request>(`/api/v1/request/${request.id}`, {
    fallbackData: request,
    revalidateOnMount: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    // Poll only while visible.
    refreshInterval: inView
      ? refreshIntervalHelper<Request>(watchRequest, request)
      : 0,
  });

  const { mutate } = swr;
  useEffect(() => {
    mutate(request, false);
  }, [request, mutate]);

  return swr;
};

export default useLiveRequest;
