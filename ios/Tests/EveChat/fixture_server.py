"""Deterministic local Eve contract server. Never connects to a real service."""
import json
import threading
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
states = {}
lock = threading.Lock()
WORKSPACE = '00000000-0000-0000-0000-000000000001'
CONVERSATION = '00000000-0000-0000-0000-000000000002'

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def reply(self, value, status=200, headers=None):
        payload = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        for k, v in (headers or {}).items(): self.send_header(k,v)
        self.end_headers()
        self.wfile.write(payload)
    def handle_request(self):
        scenario = self.headers.get('Authorization', 'Bearer unknown').removeprefix('Bearer ')
        with lock:
            state = states.setdefault(scenario, {'requests': [], 'sends': 0, 'streams': 0, 'responds': 0})
        path = urlparse(self.path).path
        size = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(size)) if size else {}
        if path == '/requests': return self.reply(state)
        state['requests'].append({'path': self.path, 'method': self.command, 'body': body,
                                  'workspace': self.headers.get('x-workspace-id'), 'ctx': self.headers.get('x-chat-run-ctx')})
        if path.endswith('/eve-session'):
            if body['action'] == 'register': return self.reply({'ok':True})
            if scenario == 'limited': return self.reply({'code':'USAGE_LIMIT', 'error':'Usage limit reached'},429)
            return self.reply({'token':'fixture-run-token', 'conversationId':CONVERSATION,
                               'eveSessionId':'retired' if scenario == 'retired' and state['sends'] == 0 else None,
                               'historyPrimer':'Earlier discussion'})
        if path.endswith('/eve-persist'): return self.reply({'written':True})
        if path == '/eve/chat-agent/v1/session': return self.reply({'sessionId':'fixture-session'},202)
        if path.endswith('/cancel'): return self.reply({'ok':True},202)
        if path.endswith('/stream'):
            state['streams'] += 1
            query = parse_qs(urlparse(self.path).query)
            cursor = int(query.get('startIndex',['0'])[0])
            events = []
            current_delivery = 'older-delivery'
            current_turn = 'turn_old'
            def event(t, data, delivery=None):
                n = len(events)
                events.append({'type':t,'data':{**dict(turnId=current_turn,stepIndex=0,sequence=0),**data},
                               'meta':{'id':'event-'+str(n),'deliveryIds':[delivery or current_delivery]}})
            event('message.appended', {'messageDelta':'OLD REPLY'})
            event('session.waiting', {})
            for turn in range(1, state['sends']+1):
                current_delivery = 'delivery-'+str(turn)
                current_turn = 'turn_'+str(turn)
                event('turn.started', {})
                event('message.received', {'kind':'user', 'message':'Hi'})
                event('message.appended', {'messageDelta':'Hello '})
                event('message.appended', {'messageDelta':'world'})
                event('message.completed', {'message':'Hello world'})
                if scenario == 'approval':
                    event('input.requested', {'requests':[{'requestId':'request-7','kind':'tool-approval','prompt':'Choose a topic',
                        'action':{'kind':'tool-call','toolName':'ask_user','callId':'tool-7','input':{'questions':[{'question':'Which topic?'}]}},
                        'options':[{'id':'approve-custom','label':'Answer'},{'id':'cancel-custom','label':'Cancel'}]}]})
                elif scenario in ('approval-v26', 'resume-partial'):
                    # v26: the question pauses the turn; it resumes under the same turnId,
                    # with a step.started and no new turn.started.
                    event('input.requested', {'requests':[{'requestId':'request-8','kind':'tool-approval','prompt':'Choose a topic',
                        'action':{'kind':'tool-call','toolName':'ask_user','callId':'tool-8','input':{'questions':[{'question':'Which topic?'}]}},
                        'options':[{'id':'approve-custom','label':'Answer'},{'id':'cancel-custom','label':'Cancel'}]}]})
                    event('turn.waiting', {'on':'input'})
                    if state['responds']:
                        event('input.resolved', {'resolutions':[{'requestId':'request-8'}]})
                        event('step.started', {'stepIndex':1})
                        event('message.appended', {'messageDelta':' Answer received.', 'stepIndex':1})
                        if scenario == 'resume-partial': continue  # still streaming
                        event('message.completed', {'message':' Answer received.', 'stepIndex':1})
                        event('turn.completed', {})
                        event('session.waiting', {})
                    continue
                elif scenario == 'signin':
                    # v26: a sign-in pauses the turn with no input.requested.
                    event('authorization.required', {'name':'github','authorization':{'url':'https://example.com/authorize'}})
                    event('turn.waiting', {'on':'input'})
                    continue
                elif scenario == 'tasks':
                    # v26: a task tool answers with a receipt, the turn waits on the task
                    # (turn.waiting with no question), then task.settled carries the result.
                    event('actions.requested', {'actions':[{'callId':'tool-9','toolName':'research','input':{'q':'notes'}}]})
                    event('action.result', {'result':{'callId':'tool-9','output':{'taskId':'task-1'}}})
                    event('task.started', {'callId':'tool-9','taskId':'task-1','name':'research','kind':'tool'})
                    event('turn.waiting', {'on':'tasks'})
                    event('task.settled', {'callId':'tool-9','taskId':'task-1','name':'research','kind':'tool','status':'completed','output':'Found 3 notes'})
                    event('turn.completed', {})
                else: event('turn.completed', {})
                event('session.waiting', {})
                if scenario == 'approval' and state['responds']:
                    event('input.resolved', {'resolutions':[{'requestId':'request-7'}]})
                    event('message.appended', {'messageDelta':' Answer received.'})
                    event('message.completed', {'message':'Hello world Answer received.'})
                    event('turn.completed', {})
                    event('session.waiting', {})
            if scenario == 'reconnect'  and state['streams'] == 1: events = events[:4]
            headers = {'Content-Type':'application/x-ndjson','x-eve-stream-tail-index':str(len(events)-1)}
            if scenario in ('approval-v26', 'resume-partial', 'signin', 'tasks'): headers['x-eve-stream-version']='26'
            elif scenario == 'future-version': headers['x-eve-stream-version']='27'
            elif scenario != 'bad-version': headers['x-eve-stream-version']='25'
            return self.reply(('\n'.join(json.dumps(x) for x in events[cursor:])+'\n').encode(), headers=headers)
        if path.endswith('/retired'):
            state['sends'] += 1
            return self.reply({'code':'session_not_active','error':'Retired'},409)
        if path.endswith('/fixture-session'):
            if 'inputResponses' in body:
                state['responds'] += 1
                # eve 0.79 (v26) gives an answer its own delivery id, while the turn it
                # resumes keeps tagging events with the original message's id.
                if scenario in ('approval-v26', 'resume-partial'): return self.reply({'sessionId':'fixture-session','deliveryId':'answer-1'},202)
                return self.reply({'sessionId':'fixture-session'},202)
            state['sends'] += 1
            if scenario == 'uncertain': return self.reply({'error':'Acknowledgement lost after acceptance'},503)
            return self.reply({'sessionId':'fixture-session', 'deliveryId':'delivery-'+str(state['sends'])},202)
        return self.reply({'error':'Unexpected route '+path},404)
    do_GET = handle_request
    do_POST = handle_request

server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
with open(sys.argv[1], 'w') as port_file: port_file.write(str(server.server_port))
server.serve_forever()
