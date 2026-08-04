import { useCallback } from 'react';
import { mergeFileConfig, getEndpointFileConfig } from 'librechat-data-provider';
import type { EToolResources } from 'librechat-data-provider';
import { useGetFileConfig } from '~/data-provider';
import { getViableUploadOptions } from '~/utils';
import { useDragDropContext } from '~/Providers';

/**
 * Resolves which upload destinations a file set can be routed to (always a single
 * destination — see getViableUploadOptions), plus whether uploads are disabled for the
 * endpoint. Shared by the paste, drag, and modal flows so they decide consistently from
 * one source.
 */
export default function useUploadOptions() {
  const { endpoint, endpointType } = useDragDropContext();
  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const endpointFileConfig = getEndpointFileConfig({ fileConfig, endpoint, endpointType });
  const uploadsDisabled = endpointFileConfig.disabled === true;

  const getOptions = useCallback(
    (files: File[]): (EToolResources | undefined)[] => getViableUploadOptions(files),
    [],
  );

  return { getOptions, uploadsDisabled };
}
