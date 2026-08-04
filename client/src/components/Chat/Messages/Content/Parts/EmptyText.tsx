import { memo } from 'react';
import { DelayedRender } from '@librechat/client';
import { useLocalize } from '~/hooks';

const GENERATING_LABEL_DELAY = 2500;

/**
 * Streaming cursor placeholder — no bottom margin to match Container's structure and prevent CLS.
 * Agentic, tool-call-heavy turns (e.g. GLM 5.2 working through several MCP tool calls before
 * emitting any text) can sit in this empty state for 10-20+ seconds with nothing else on screen,
 * which reads as frozen. After a short delay, add a "Generating..." label alongside the pulsing
 * dot so a slow turn still looks alive — short enough responses never see it, since this
 * component unmounts the moment real content arrives.
 */
const EmptyTextPart = memo(() => {
  const localize = useLocalize();
  return (
    <div className="text-message flex min-h-[20px] flex-col items-start gap-3 overflow-visible">
      <div className="markdown prose dark:prose-invert light w-full break-words dark:text-gray-100">
        <div className="absolute">
          <p className="submitting relative">
            <span className="result-thinking" />
          </p>
        </div>
        <DelayedRender delay={GENERATING_LABEL_DELAY}>
          <span className="ml-5 text-xs text-text-secondary">{localize('com_ui_generating')}</span>
        </DelayedRender>
      </div>
    </div>
  );
});

export default EmptyTextPart;
