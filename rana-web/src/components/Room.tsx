// 她的房间：应用背景场景层（墙、窗、搁板小物件、吉他、灯串、墙裙）。
// 全 CSS/SVG 手绘不引版权图；用户设置自定义背景图时整个房间让位（body.has-bg 控制）。
// 所有动画尊重系统"减少动态效果"设置（styles.css 内 media query 关闭）。
export default function Room() {
  return (
    <div className="room" aria-hidden>
      <div className="wall" />
      <div className="garland">
        {Array.from({ length: 12 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className="shelf">
        <div className="items">
          {/* 抹茶芭菲 */}
          <svg className="it-parfait" viewBox="0 0 34 52">
            <path d="M6 14 L28 14 L24 48 Q23.5 51 20 51 L14 51 Q10.5 51 10 48 Z" fill="#eef7f2" opacity=".92" stroke="#cfe4da" />
            <path d="M8 30 L26 30 L24 48 Q23.5 51 20 51 L14 51 Q10.5 51 10 48 Z" fill="#9ccc7a" />
            <path d="M7.5 22 Q17 26 26.5 22 L26 30 Q17 34 8 30 Z" fill="#f7f3e8" />
            <circle cx="17" cy="9" r="5" fill="#e86a5c" />
            <path d="M17 4 q1-3 3-4" stroke="#5faf6e" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
          {/* 毛线球 */}
          <svg className="it-yarn" viewBox="0 0 34 34">
            <circle cx="17" cy="17" r="14" fill="#f3a0b5" />
            <path
              d="M5 13 Q17 5 29 13 M4 20 Q17 12 30 20 M7 27 Q17 19 27 27"
              stroke="#e97f9c"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
            />
            <path d="M28 22 Q34 26 32 32" stroke="#e97f9c" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
          {/* 铃铛 */}
          <svg className="it-bell" viewBox="0 0 24 24">
            <rect x="10.4" y="1.6" width="3.2" height="3" rx="1.4" fill="#d9a520" />
            <path
              d="M12 3.4c4.5 0 7.2 3.3 7.2 7.8 0 2.7.6 4.2 1.5 5.3.5.6.1 1.7-.8 1.7H4.1c-.9 0-1.3-1.1-.8-1.7.9-1.1 1.5-2.6 1.5-5.3C4.8 6.7 7.5 3.4 12 3.4z"
              fill="#f5c84c"
              stroke="#d9a520"
              strokeWidth="1.1"
            />
            <circle cx="12" cy="20.6" r="1.9" fill="#e8b62e" stroke="#c99418" strokeWidth=".8" />
          </svg>
          {/* 相框（睡着的她） */}
          <div className="it-frame">
            <svg viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="30" fill="#eef7e8" />
              <ellipse cx="32" cy="40" rx="15" ry="12" fill="#fff5ef" />
              <path
                d="M17.5,35 C17.5,24 24,18 32,18 C40,18 46.5,24 46.5,35 Q44,38 41.5,35 Q39,38 36.5,35 Q34,38 31.5,35 Q29,38 26.5,35 Q24,38 21.5,35 Q19.4,37 17.5,35 Z"
                fill="#efe4ea"
              />
              <path d="M23,40 q2.9,2.4 5.8,0" stroke="#6b5a63" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M35.6,40 q2.9,2.4 5.8,0" stroke="#6b5a63" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M30,45.5 q1.1,1.5 2.2,0 q1.1,1.5 2.2,0" stroke="#6b5a63" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            </svg>
          </div>
        </div>
        <div className="plank" />
        <span className="bracket" />
        <span className="bracket" />
      </div>
      <div className="window">
        <div className="win-sky">
          <div className="stars">
            {Array.from({ length: 5 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <div className="sun" />
          <div className="win-cloud" />
        </div>
      </div>
      {/* 角落的吉他（她的 ESP POTBELLY 剪影） */}
      <svg className="guitar-corner" viewBox="0 0 60 120">
        <rect x="27" y="2" width="6" height="52" rx="2.5" fill="#8a6b4f" />
        <rect x="24.5" y="0" width="11" height="13" rx="3" fill="#6e543c" />
        <path
          d="M30 52 c13 0 17 8 17 17 0 6-3 9-3 14 0 6 4 8 4 15 0 12-9 20-18 20 s-18-8-18-20 c0-7 4-9 4-15 0-5-3-8-3-14 0-9 4-17 17-17z"
          fill="#5faf6e"
        />
        <rect x="28.6" y="54" width="2.8" height="60" rx="1.4" fill="#f4f1e6" opacity=".85" />
        <circle cx="30" cy="96" r="4.5" fill="#3d8a4f" />
        <rect x="20" y="86" width="20" height="6" rx="3" fill="#3d8a4f" opacity=".8" />
      </svg>
      <div className="wainscot" />
    </div>
  );
}
