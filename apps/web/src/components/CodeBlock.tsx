import { useEffect, useRef, useState, type ReactNode } from 'react';
import Icon from './Icon';

/**
 * 复制到剪贴板。navigator.clipboard 只在安全上下文（HTTPS、localhost）里有；
 * 用 http + 局域网 / Tailscale 地址打开时退回到老办法：临时文本框 + execCommand。
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器不允许复制');
  } finally {
    ta.remove();
  }
}

/** 代码块：右上角一个复制按钮（悬停时出现，触屏上常驻） */
export default function CodeBlock({
  text,
  className,
  lang,
  children,
}: {
  /** 复制的内容 */
  text: string;
  className?: string;
  lang?: string;
  /** 显示的内容，默认就是 text */
  children?: ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    copyText(text).then(
      () => setState('done'),
      () => setState('error'),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  return (
    <div className="codebox">
      <pre className={`code${className ? ` ${className}` : ''}`} data-lang={lang || undefined}>
        {children ?? text}
      </pre>
      <button
        type="button"
        className={`codebox__copy${state !== 'idle' ? ' is-shown' : ''}`}
        onClick={copy}
        aria-label="复制"
        title="复制"
      >
        {state === 'done' ? (
          <>
            <Icon name="check" size={13} />
            已复制
          </>
        ) : state === 'error' ? (
          '复制失败'
        ) : (
          <Icon name="copy" size={13} />
        )}
      </button>
    </div>
  );
}
