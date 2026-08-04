import React, { useRef, useState, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { FileUp } from 'lucide-react';
import {
  FileUpload,
  TooltipAnchor,
  DropdownPopup,
  AttachmentIcon,
  SharePointIcon,
} from '@librechat/client';
import type { TConversation, EndpointFileConfig } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useFileHandlingNoChatContext, useLocalize } from '~/hooks';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { SharePointPickerDialog } from '~/components/SharePoint';
import { useGetStartupConfig } from '~/data-provider';
import { MenuItemProps } from '~/common';
import { cn } from '~/utils';

interface AttachFileMenuProps {
  agentId?: string | null;
  endpoint?: string | null;
  disabled?: boolean | null;
  conversationId: string;
  endpointType?: string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}

/**
 * ADR fork: every attachment, from every upload path (paperclip, drag-drop,
 * paste), is diverted to the sandbox server-side before it ever reaches the
 * model (see BaseClient.js processAttachments + getViableUploadOptions in
 * utils/files.ts, which now always resolves to a single destination). There
 * is no longer a meaningful "where should this go" choice, so this menu
 * offers exactly one upload action — matching drag-and-drop and paste,
 * which already auto-route without asking. SharePoint stays a separate item
 * because it's a different upload *source* (a file picker), not a
 * destination.
 */
const AttachFileMenu = ({
  disabled,
  endpointFileConfig,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: AttachFileMenuProps) => {
  const localize = useLocalize();
  const isUploadDisabled = disabled ?? false;
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const uploadFileTooltip = useShortcutHint('uploadFile', localize('com_sidepanel_attach_files'));
  const uploadFileAriaKey = useShortcutAriaKey('uploadFile');

  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      { toolResource: undefined },
      { files, setFiles, setFilesLoading, conversation },
    );

  const { data: startupConfig } = useGetStartupConfig();
  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;

  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);

  const handleUploadClick = useCallback(() => {
    if (!inputRef.current) {
      return;
    }
    inputRef.current.value = '';
    inputRef.current.accept = '';
    inputRef.current.click();
  }, []);

  const handleSharePointFilesSelected = async (sharePointFiles: any[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };

  const plainButton = (
    <TooltipAnchor
      render={
        <button
          type="button"
          disabled={isUploadDisabled}
          id="attach-file-menu-button"
          aria-label={localize('com_sidepanel_attach_files')}
          aria-keyshortcuts={uploadFileAriaKey}
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
          )}
          onClick={handleUploadClick}
        >
          <div className="flex w-full items-center justify-center gap-2">
            <AttachmentIcon />
          </div>
        </button>
      }
      id="attach-file-menu-button"
      description={uploadFileTooltip}
      disabled={isUploadDisabled}
    />
  );

  const dropdownItems: MenuItemProps[] = [
    {
      label: localize('com_ui_upload_files'),
      onClick: handleUploadClick,
      icon: <FileUp className="icon-md" />,
    },
    {
      label: localize('com_files_upload_sharepoint'),
      onClick: () => setIsSharePointDialogOpen(true),
      icon: <SharePointIcon className="icon-md" />,
    },
  ];

  const menuTrigger = (
    <TooltipAnchor
      render={
        <Ariakit.MenuButton
          disabled={isUploadDisabled}
          id="attach-file-menu-button"
          aria-label="Attach File Options"
          aria-keyshortcuts={uploadFileAriaKey}
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
            isPopoverActive && 'bg-surface-hover',
          )}
        >
          <div className="flex w-full items-center justify-center gap-2">
            <AttachmentIcon />
          </div>
        </Ariakit.MenuButton>
      }
      id="attach-file-menu-button"
      description={uploadFileTooltip}
      disabled={isUploadDisabled}
    />
  );

  return (
    <>
      <FileUpload ref={inputRef} handleFileChange={handleFileChange}>
        {sharePointEnabled ? (
          <DropdownPopup
            menuId="attach-file-menu"
            className="overflow-visible"
            isOpen={isPopoverActive}
            setIsOpen={setIsPopoverActive}
            modal={true}
            unmountOnHide={true}
            trigger={menuTrigger}
            items={dropdownItems}
            iconClassName="mr-0"
          />
        ) : (
          plainButton
        )}
      </FileUpload>
      {sharePointEnabled && (
        <SharePointPickerDialog
          isOpen={isSharePointDialogOpen}
          onOpenChange={setIsSharePointDialogOpen}
          onFilesSelected={handleSharePointFilesSelected}
          isDownloading={isProcessing}
          downloadProgress={downloadProgress}
          maxSelectionCount={endpointFileConfig?.fileLimit}
        />
      )}
    </>
  );
};

export default React.memo(AttachFileMenu);
