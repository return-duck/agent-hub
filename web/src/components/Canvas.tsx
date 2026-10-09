import { useCallback, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { GraphNode } from './GraphNode.js';
import { useStudio } from '../store/studioStore.js';

const nodeTypes: NodeTypes = {
  start: GraphNode,
  prompt: GraphNode,
  llm: GraphNode,
  end: GraphNode,
};

function CanvasInner() {
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const onNodesChange = useStudio((s) => s.onNodesChange);
  const onEdgesChange = useStudio((s) => s.onEdgesChange);
  const onConnect = useStudio((s) => s.onConnect);
  const selectNode = useStudio((s) => s.selectNode);
  const addNode = useStudio((s) => s.addNode);

  const wrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const [dragOver, setDragOver] = useState(false);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);
      const type = event.dataTransfer.getData('application/agent-node');
      if (!type) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(type, position);
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <div
      className={`canvas ${dragOver ? 'canvas-dragover' : ''}`}
      ref={wrapper}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => selectNode(node.id)}
        onPaneClick={() => selectNode(null)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} color="#243044" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="#3b82f6" maskColor="rgba(10,15,25,0.7)" />
      </ReactFlow>

      {/* 连线方式不是自明的：默认锚点只有 5px，用户会误以为"拖节点主体就能连线"。
          这行提示直接说明该从哪里拖（拖主体只会移动节点）。 */}
      <div className="canvas__hint">
        连线：从节点<b>左侧/右侧的圆点</b>拖到另一个节点的圆点。
        拖动节点主体只会移动它。
      </div>
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
