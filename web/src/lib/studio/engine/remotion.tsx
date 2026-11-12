import { Composition, getInputProps, registerRoot } from 'remotion';
import { EditorComposition } from './composition';
import { projectDuration } from './timeline';
import { deliveredProject } from './formats';
import type { EditorProject } from './contracts';
function Root() { const props = getInputProps<{ project: EditorProject; fonts?: import('./font-faces').FontFace[] }>(); const { project: edit } = props, project = deliveredProject(edit);
  return <Composition id="EditorVideo" component={EditorComposition} defaultProps={props} width={project.output.width} height={project.output.height}
    fps={project.output.fps} durationInFrames={projectDuration(project)} />;
}
registerRoot(Root);
