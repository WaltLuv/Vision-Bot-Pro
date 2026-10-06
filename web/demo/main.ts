// Preview entry: the stand-in gateway, the preview's employee, browser,
// camera and connected apps, then the real application, untouched.
import './preview.css';
import {apps} from './apps';
import {control, installLiveView, stopBrowsing} from './browser';
import {installSampleCamera, sceneBlob} from './camera';
import {installPreviewChrome, setSignedIn} from './chrome';
import {resumeSampleOrder, startTask, stopTask} from './employee';
import {installGateway, preview, resetPreview, whenRestored} from './gateway';
import {inspect, pictureChanged} from './inspect';

// A published page cannot run a service worker; the app's registration is told so, as it would be by the browser.
Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: {register: () => Promise.reject(new Error('Not available in the preview.'))}});

let camera: ReturnType<typeof installSampleCamera> = null;
try {camera = installSampleCamera();} catch {/* a page that forbids it still gets the app's own camera message */}
installPreviewChrome({usePhoto: camera ? file => camera!.usePhoto(file).then(pictureChanged) : undefined, reset: resetPreview});
installGateway({
  startTask,
  stopTask: runId => {stopTask(runId); stopBrowsing(runId);},
  takeOver: id => control(id, 'takeover'),
  handBack: id => control(id, 'handback'),
  stopBrowser: id => control(id, 'stop'),
  signedIn: setSignedIn,
  apps,
  inspect,
});
installLiveView();
// The sample purchase is asked about once the viewer's saved account, if any, is back.
void whenRestored.then(() => {setSignedIn(preview.signedIn); resumeSampleOrder();});
void sceneBlob().then(blob => {if (blob) preview.uploads.set('artifact-photo', blob);});

void import('../src/main');
