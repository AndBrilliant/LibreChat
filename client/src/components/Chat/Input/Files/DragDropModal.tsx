import React, { useMemo } from 'react';
import { OGDialog, OGDialogTemplate } from '@librechat/client';
import { FileUp } from 'lucide-react';
import { useLocalize, useUploadOptions, useFileUploadRouter } from '~/hooks';
import { useUploadModalContext } from '~/Providers';

/**
 * ADR fork: getViableUploadOptions (utils/files.ts) now always resolves to a
 * single destination, so useDragHelpers/useTextarea auto-route before this
 * modal would ever open — it's kept only as an inert fallback (matches the
 * `options.length === 0` error-toast branch alongside it) rather than
 * ripped out, since the drag/paste call sites still branch on option count.
 */
const DragDropModal = () => {
  const localize = useLocalize();
  const { isVisible, files, closeModal } = useUploadModalContext();
  const { getOptions } = useUploadOptions();
  const routeFiles = useFileUploadRouter();

  const getOptionMeta = () => ({
    label: localize('com_ui_upload_files'),
    icon: <FileUp className="icon-md" />,
  });

  const options = useMemo(() => getOptions(files), [getOptions, files]);

  if (!isVisible) {
    return null;
  }

  return (
    <OGDialog open={isVisible} onOpenChange={(open) => !open && closeModal()}>
      <OGDialogTemplate
        title={localize('com_ui_upload_type')}
        className="w-11/12 sm:w-[440px] md:w-[400px] lg:w-[360px]"
        main={
          <div className="flex flex-col gap-2">
            {options.map((value) => {
              const { label, icon } = getOptionMeta();
              return (
                <button
                  key={value ?? 'provider'}
                  onClick={() => {
                    routeFiles(files, value);
                    closeModal();
                  }}
                  className="flex items-center gap-2 rounded-lg p-2 hover:bg-surface-active-alt"
                >
                  {icon}
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        }
      />
    </OGDialog>
  );
};

export default DragDropModal;
