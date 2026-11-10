import { Component, type ReactNode } from 'react'

/** Wraps something optional (a picture viewer, loaded only when needed): if it fails to load or to
 * draw, it disappears and `onError` is called, instead of taking the whole screen down with it. */
export class SoftBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
