// 术语悬停注释：悬停/聚焦术语时，把注释气泡挂到 document.body 顶层（portal），
// 用 fixed 定位贴着术语放——不受祖先 overflow 裁切、不被相邻元素的层叠上下文盖住。
// 注释全部本地（fateGlossary）；库里没有的词条原样显示、不挂气泡。
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { GLOSSARY } from "../../lib/fateGlossary";

export default function Term({ k, children }: { k: string; children?: ReactNode }) {
  const tip = GLOSSARY[k];
  const ref = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; above: boolean } | null>(null);

  if (!tip) return <>{children ?? k}</>;

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(248, window.innerWidth - 16);
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const above = r.top > 130; // 上面空间够就放上方，否则放下方
    const y = above ? r.top - 8 : r.bottom + 8;
    setBox({ x, y, w, above });
  };

  return (
    <>
      <span
        ref={ref}
        className="term"
        onMouseEnter={show}
        onMouseLeave={() => setBox(null)}
        onFocus={show}
        onBlur={() => setBox(null)}
      >
        {children ?? k}
      </span>
      {box &&
        createPortal(
          <div
            className="term-tip"
            style={{ left: box.x, top: box.y, width: box.w, transform: box.above ? "translateY(-100%)" : undefined }}
          >
            {tip}
          </div>,
          document.body,
        )}
    </>
  );
}
