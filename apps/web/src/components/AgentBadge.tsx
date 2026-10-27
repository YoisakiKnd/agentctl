import type { AgentId } from '../types';
import { AGENT_LABEL } from '../types';

/** 身份色 + 两个字母：颜色之外还有文字，色弱也分得清 */
export const AGENT_ABBR: Record<AgentId, string> = { claude: 'CC', codex: 'CX', dsh: 'DS', pi: 'PI', cursor: 'CU' };

export function AgentBadge({ agent, size = 'md' }: { agent: AgentId; size?: 'sm' | 'md' }) {
  return (
    <span className={`abadge abadge--${size}`} style={{ '--agent': `var(--${agent})` } as React.CSSProperties} title={AGENT_LABEL[agent]}>
      {AGENT_ABBR[agent]}
    </span>
  );
}
