interface LogoProps {
  size?: number;
}

/**
 * Az-term 站标：终端提示符 `>` + 橙色光标方块，底部一条进度条。
 * 蓝紫渐变底 + 橙色点缀 —— 沿用 Azi36 家族配色，符号换成终端专属。
 */
export function Logo({ size = 24 }: LogoProps) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <defs>
          <linearGradient id="azterm-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2447e6" />
            <stop offset="1" stopColor="#7c5ce0" />
          </linearGradient>
        </defs>
        <rect width="48" height="48" rx="11" fill="url(#azterm-g)" />
        {/* 提示符 > */}
        <path d="M15 17 22 24 15 31" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {/* 光标方块（橙） */}
        <rect x="26" y="27" width="8" height="4.5" rx="1.2" fill="#ffb02e" />
        {/* 底部进度条 */}
        <path d="M14 39h20" stroke="rgba(255,255,255,.82)" strokeWidth="3" strokeLinecap="round" />
        <path d="M14 39h8" stroke="#ffb02e" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}
