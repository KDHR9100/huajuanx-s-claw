// 手绘乐奈脸（SVG，醒/睡两种）。用户上传自定义头像后（settings.avatarUrl）优先显示上传图。
// 特征：银发水母头齐刘海、异色瞳（左蓝右黄）、猫嘴 ω、绿发夹。
import { useAppStore } from "../store/useAppStore";

/** 乐奈的头像：上传图优先，否则手绘脸（asleep 可选睡颜） */
export function RanaAvatar({ asleep = false, size = 40 }: { asleep?: boolean; size?: number }) {
  const avatarUrl = useAppStore((s) => s.settings.avatarUrl);
  if (avatarUrl) {
    return <img className="rana-avatar-img" src={avatarUrl} alt="Rana" width={size} height={size} />;
  }
  return <RanaFace asleep={asleep} size={size} />;
}

export function RanaFace({ asleep = false, size = 40 }: { asleep?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="rana-avbg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eef7e8" />
          <stop offset="1" stopColor="#d3ecc9" />
        </linearGradient>
        <linearGradient id="rana-avhair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2e9ee" />
          <stop offset="1" stopColor="#d7c3cf" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill="url(#rana-avbg)" />
      <path d="M9,34 a23,24 0 1 1 46,0 v13 a4,4 0 0 1 -4,4 h-38 a4,4 0 0 1 -4,-4 z" fill="url(#rana-avhair)" />
      <ellipse cx="32" cy="37.5" rx="14.5" ry="13" fill="#fff5ef" />
      <path
        d="M17.5,33 C17.5,21.5 24,15 32,15 C40,15 46.5,21.5 46.5,33 Q44,36.2 41.5,33 Q39,36.2 36.5,33 Q34,36.2 31.5,33 Q29,36.2 26.5,33 Q24,36.2 21.5,33 Q19.4,35 17.5,33 Z"
        fill="#efe4ea"
      />
      {asleep ? (
        <>
          <path d="M22.6,38.6 q2.9,2.6 5.8,0" stroke="#6b5a63" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M35.6,38.6 q2.9,2.6 5.8,0" stroke="#6b5a63" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <ellipse cx="25.5" cy="38.5" rx="2.6" ry="3" fill="#5aa9e6" />
          <ellipse cx="38.5" cy="38.5" rx="2.6" ry="3" fill="#f0c94a" />
          <circle cx="24.6" cy="37.4" r=".9" fill="#fff" />
          <circle cx="37.6" cy="37.4" r=".9" fill="#fff" />
          <path d="M23,36.7 q2.5,-1.4 5,0" stroke="#6b5a63" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M36,36.7 q2.5,-1.4 5,0" stroke="#6b5a63" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </>
      )}
      <ellipse cx="21.5" cy="43" rx="2.8" ry="1.6" fill="#f3c3cd" opacity=".8" />
      <ellipse cx="42.5" cy="43" rx="2.8" ry="1.6" fill="#f3c3cd" opacity=".8" />
      <path d="M29.8,44.4 q1.1,1.5 2.2,0 q1.1,1.5 2.2,0" stroke="#6b5a63" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path
        d="M46.8,15.6 l4.6,1.1 c1,.25 1.3,1.5 .5,2.2 l-3.6,3 c-.75,.6 -1.9,.15 -2,-.8 l-.85,-4.2 c-.1,-.95 .55,-1.55 1.35,-1.3 z"
        fill="#77dd77"
      />
    </svg>
  );
}

/** 铃铛图标（品牌/头像徽章用） */
export function Bell({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="10.4" y="1.6" width="3.2" height="3" rx="1.4" fill="#d9a520" />
      <path
        d="M12 3.4c4.5 0 7.2 3.3 7.2 7.8 0 2.7.6 4.2 1.5 5.3.5.6.1 1.7-.8 1.7H4.1c-.9 0-1.3-1.1-.8-1.7.9-1.1 1.5-2.6 1.5-5.3C4.8 6.7 7.5 3.4 12 3.4z"
        fill="#f5c84c"
        stroke="#d9a520"
        strokeWidth="1.1"
      />
      <rect x="4.6" y="17.2" width="14.8" height="1.6" rx=".8" fill="#d9a520" />
      <circle cx="12" cy="20.6" r="1.9" fill="#e8b62e" stroke="#c99418" strokeWidth=".8" />
    </svg>
  );
}

/** 猫爪图标（发送键/等待动画用） */
export function Paw({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <ellipse cx="12" cy="16" rx="5.4" ry="4.5" />
      <ellipse cx="5.4" cy="10.6" rx="2.1" ry="2.7" transform="rotate(-18 5.4 10.6)" />
      <ellipse cx="9.9" cy="7.4" rx="2.1" ry="2.8" />
      <ellipse cx="14.7" cy="7.6" rx="2.1" ry="2.8" transform="rotate(8 14.7 7.6)" />
      <ellipse cx="18.8" cy="11" rx="2" ry="2.6" transform="rotate(20 18.8 11)" />
    </svg>
  );
}
