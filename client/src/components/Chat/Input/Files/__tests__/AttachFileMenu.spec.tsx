import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AttachFileMenu from '../AttachFileMenu';

jest.mock('~/hooks', () => ({
  useFileHandlingNoChatContext: jest.fn(),
  useLocalize: jest.fn(),
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  __esModule: true,
  default: jest.fn(),
  useSharePointFileHandlingNoChatContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

jest.mock('~/components/SharePoint', () => ({
  SharePointPickerDialog: () => null,
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    FileUpload: R.forwardRef((props, ref) =>
      R.createElement(
        'div',
        { 'data-testid': 'file-upload' },
        props.children,
        R.createElement('input', {
          ref,
          multiple: true,
          type: 'file',
          'data-testid': 'file-input',
          onChange: props.handleFileChange,
        }),
      ),
    ),
    TooltipAnchor: (props) => props.render,
    DropdownPopup: (props) =>
      R.createElement(
        'div',
        null,
        R.createElement('div', { onClick: () => props.setIsOpen(!props.isOpen) }, props.trigger),
        props.isOpen &&
          R.createElement(
            'div',
            { 'data-testid': 'dropdown-menu' },
            props.items.map((item, idx) =>
              R.createElement(
                'button',
                { key: idx, onClick: item.onClick, 'data-testid': `menu-item-${idx}` },
                item.label,
              ),
            ),
          ),
      ),
    AttachmentIcon: () => R.createElement('span', { 'data-testid': 'attachment-icon' }),
    SharePointIcon: () => R.createElement('span', { 'data-testid': 'sharepoint-icon' }),
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('@ariakit/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MenuButton: (props) => R.createElement('button', props, props.children),
  };
});

const mockUseFileHandlingNoChatContext = jest.requireMock('~/hooks').useFileHandlingNoChatContext;
const mockUseLocalize = jest.requireMock('~/hooks').useLocalize;
const mockUseSharePointFileHandling = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).default;
const mockUseSharePointFileHandlingNoChatContext = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).useSharePointFileHandlingNoChatContext;
const mockUseGetStartupConfig = jest.requireMock('~/data-provider').useGetStartupConfig;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function setupMocks(overrides: { sharePointEnabled?: boolean } = {}) {
  const translations: Record<string, string> = {
    com_files_upload_sharepoint: 'From SharePoint',
    com_sidepanel_attach_files: 'Attach Files',
    com_ui_upload_files: 'Upload files',
  };
  mockUseLocalize.mockReturnValue((key: string) => translations[key] || key);
  mockUseFileHandlingNoChatContext.mockReturnValue({ handleFileChange: jest.fn() });
  const sharePointReturnValue = {
    handleSharePointFiles: jest.fn(),
    isProcessing: false,
    downloadProgress: 0,
    error: null,
  };
  mockUseSharePointFileHandling.mockReturnValue(sharePointReturnValue);
  mockUseSharePointFileHandlingNoChatContext.mockReturnValue(sharePointReturnValue);
  mockUseGetStartupConfig.mockReturnValue({
    data: { sharePointFilePickerEnabled: overrides.sharePointEnabled ?? false },
  });
}

function renderMenu(props: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileMenu
          conversationId="test-convo"
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
          conversation={null}
          {...props}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('AttachFileMenu', () => {
  beforeEach(jest.clearAllMocks);

  describe('SharePoint disabled (the common case)', () => {
    it('renders a single plain button with no dropdown menu', () => {
      setupMocks();
      renderMenu();
      expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-menu')).not.toBeInTheDocument();
    });

    it('clicking the button triggers the hidden file input, not a menu', () => {
      setupMocks();
      const clickSpy = jest.spyOn(HTMLInputElement.prototype, 'click');
      renderMenu();
      fireEvent.click(screen.getByRole('button', { name: /attach files/i }));
      expect(clickSpy).toHaveBeenCalled();
      clickSpy.mockRestore();
    });

    it('is disabled when disabled prop is true', () => {
      setupMocks();
      renderMenu({ disabled: true });
      expect(screen.getByRole('button', { name: /attach files/i })).toBeDisabled();
    });
  });

  describe('SharePoint enabled', () => {
    it('renders exactly two destination-agnostic upload sources: computer and SharePoint', () => {
      setupMocks({ sharePointEnabled: true });
      renderMenu();
      fireEvent.click(screen.getByRole('button', { name: /attach file options/i }));
      const menu = screen.getByTestId('dropdown-menu');
      expect(menu).toBeInTheDocument();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
      expect(screen.getByText('From SharePoint')).toBeInTheDocument();
      expect(menu.querySelectorAll('button')).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    it('handles undefined endpoint/agentId props gracefully', () => {
      setupMocks();
      renderMenu({ endpoint: undefined, endpointType: undefined, agentId: undefined });
      expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
    });

    it('handles null conversation gracefully', () => {
      setupMocks();
      renderMenu({ conversation: null });
      expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
    });
  });
});
