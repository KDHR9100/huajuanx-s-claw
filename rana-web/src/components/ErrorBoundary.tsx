// ErrorBoundary：页面级兜底——某页渲染崩了只挂那一页，给出原因与重试按钮，
// 不再像 KNOWN-ISSUES 里那次一样整站白屏（nav 一起没）。
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 控制台留全栈，页面只说人话
    console.error(`[${this.props.label}] 渲染异常`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card pending" style={{ margin: "24px auto", maxWidth: 560 }}>
          <p className="pending-text">
            ⚠「{this.props.label}」页面渲染出错了：{String(this.state.error.message || this.state.error)}
          </p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            🔄 重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
