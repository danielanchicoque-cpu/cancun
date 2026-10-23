import { useEditor } from './store'
import { Home } from './components/Home'
import { Editor } from './components/Editor'
import { useBridge } from './bridge'

export function App() {
  const hasProject = useEditor((s) => s.project !== null)
  useBridge()
  return hasProject ? <Editor /> : <Home />
}
