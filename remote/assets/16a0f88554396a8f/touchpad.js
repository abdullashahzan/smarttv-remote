/* Local gestures and ordered delivery for the optional phone touchpad. */
globalThis.CouchDeckPhoneTouchpad=function ({get,context,reason,packet,post,edge,settings,notice}) {
  const trigger=get('open-touchpad'), buttons=get('open-buttons'), dpad=get('remote-dpad'), pad=get('touchpad-surface');
  const points=new Map();
  const framePeriod=1000/60, motionLifetime=65;
  const tapWindow=235, slop=4;
  let open=false, epoch, heartbeat, frame=null, lastMotion=-Infinity, moveSeq=0, strokeSeq=0;
  const flights=new Set();
  let pending, barrier=Promise.resolve(), waiting=0;
  let gesture, hold, tap, tapTimer;

  const haptic=()=>{if(settings.touchpadHaptics)navigator.vibrate?.(10);};

  function draw() {
    buttons.setAttribute('aria-pressed',String(!open));
    trigger.setAttribute('aria-expanded',String(open));
    trigger.setAttribute('aria-pressed',String(open));
    trigger.setAttribute('aria-disabled',String(Boolean(reason())));
    trigger.title=reason();
    dpad.inert=open;
    dpad.hidden=open;
    pad.hidden=!open;
  }

  const canDispatch=motion=>!waiting && flights.size<(motion.scroll?1:4);

  function dispatchMotion() {
    const {dx,dy,scroll,epoch,stroke}=pending;
    pending=null;
    lastMotion=performance.now();
    const limit=scroll?192:100000;
    const clamp=delta=>Math.min(limit,Math.max(-limit,delta));
    const payload={dx:clamp(dx),dy:clamp(dy)};
    if (!scroll) Object.assign(payload,{seq:++moveSeq,stroke});
    const flight=post(packet(scroll?'pointer_scroll':'pointer_move',payload,epoch),false)
      .catch(()=>{}).finally(()=>flights.delete(flight));
    flights.add(flight);
  }

  function clearMotion() {
    pending=null;
    if(frame!==null)cancelAnimationFrame(frame);
    frame=null;
  }

  function tick(now) {
    frame=null;
    if (!open||!pending) return;
    if (!points.size||performance.now()-pending.at>motionLifetime) { pending=null; return; }
    if (!canDispatch(pending)||now-lastMotion<framePeriod) {
      frame=requestAnimationFrame(tick);return;
    }
    dispatchMotion();
  }

  function move(dx,dy,scroll) {
    if (!dx&&!dy) return;
    const now=performance.now();
    if (scroll) {
      if (!pending?.scroll||now-pending.at>motionLifetime) pending={dx:0,dy:0,scroll,epoch,at:now};
      pending.dx+=dx;pending.dy+=dy;
    } else {
      // A newer sample includes the whole stroke so a skipped packet never loses distance.
      gesture.x+=dx;gesture.y+=dy;
      pending={dx:gesture.x,dy:gesture.y,stroke:gesture.stroke,scroll,epoch,at:now};
    }
    if (canDispatch(pending) && now-lastMotion>=framePeriod) dispatchMotion();
    else if (frame===null) frame=requestAnimationFrame(tick);
  }

  function order(name,payload) {
    const previous=[...flights], currentEpoch=epoch;
    waiting++;
    const next=barrier.then(async()=>{
      await Promise.all(previous);
      if (name) await post(packet(name,payload,currentEpoch),true);
    });
    barrier=next.catch(error=>{
      if(open&&currentEpoch===epoch){ close(false);notice(error.message); }
    }).finally(()=>{waiting--;});
    return barrier;
  }

  function click(button,count=1) {
    haptic();
    void order('pointer_click',{button,count});
  }

  function cancelTap() {
    clearTimeout(tapTimer);
    tap=null;
  }

  function resetGesture() {
    clearTimeout(hold);
    cancelTap();
    const captured=[...points.keys()];
    points.clear();gesture=null;
    for(const id of captured)if(pad.hasPointerCapture(id))pad.releasePointerCapture(id);
  }

  function close(send=true) {
    if(!open)return;
    open=false;
    clearInterval(heartbeat);
    resetGesture();
    clearMotion();
    draw();
    if(send)return order('touchpad_state',{open:false});
  }

  function activate() {
    if(open)return;
    const unavailable=reason();
    if(unavailable){notice(unavailable);return;}
    epoch=context();
    open=true;
    draw();
    void order('touchpad_state',{open:true});
    heartbeat=setInterval(()=>{
      if(!waiting)void order('touchpad_state',{open:true});
    },1000);
  }

  trigger.onclick=activate;
  buttons.onclick=()=>close();

  pad.onpointerdown=event=>{
    if(!open||edge(event)||event.button!==0||points.size>=2)return;
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(points.size===2){
      clearMotion();
      clearTimeout(hold);cancelTap();
      if(gesture.dragging){
        void order('pointer_up',{button:'left'});
        gesture.dragging=false;
      }
      gesture.fingers=2;
      gesture.slopX=gesture.slopY=0;
      return;
    }
    const second=Boolean(tap&&performance.now()-tap.at<=tapWindow);
    if(second)cancelTap();
    gesture={fingers:1,slopX:0,slopY:0,x:0,y:0,stroke:++strokeSeq,second,moved:false,used:false,dragging:false};
    const start=gesture;
    hold=setTimeout(()=>{
      if(gesture!==start||start.moved||points.size!==1)return;
      if(start.second){
        start.dragging=true;
        void order('pointer_down',{button:'left'});
      }else{
        start.used=true;
        click('right');
      }
    },480);
  };

  pad.onpointermove=event=>{
    const last=points.get(event.pointerId);
    if(!last||!gesture)return;
    let dx=event.clientX-last.x, dy=event.clientY-last.y;
    points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(gesture.used||gesture.fingers===2&&points.size!==2)return;
    if(points.size===2){dx/=2;dy/=2;}
    if(!gesture.moved){
      gesture.slopX+=dx;gesture.slopY+=dy;
      if(Math.hypot(gesture.slopX,gesture.slopY)<slop)return;
      dx=gesture.slopX;dy=gesture.slopY;
    }
    clearTimeout(hold);
    gesture.moved=true;
    if(gesture.fingers===2){
      const scale=settings.touchpadScroll==='reversed'?4:-4;
      move(dx*scale,dy*scale,true);
      return;
    }
    if(gesture.second&&!gesture.dragging){
      gesture.dragging=true;
      void order('pointer_down',{button:'left'});
    }
    const speed={slow:1.2,normal:2.2,fast:3}[settings.touchpadSpeed]||2.2;
    const gain=speed*(1+Math.min(.6,Math.hypot(dx,dy)/30));
    move(dx*gain,dy*gain,false);
  };

  function finish(event,cancelled) {
    if(!points.has(event.pointerId)||!gesture)return;
    if(!cancelled)pad.onpointermove(event);
    // Send the fresh final point now, never wait for an old request after lift.
    if(!cancelled && pending && performance.now()-pending.at<35 && canDispatch(pending)) dispatchMotion();
    points.delete(event.pointerId);
    clearMotion();
    clearTimeout(hold);
    if(points.size){if(cancelled)gesture.used=true;return;}
    const last=gesture;
    gesture=null;
    if(last.dragging){void order('pointer_up',{button:'left'});return;}
    if(cancelled||last.moved||last.used)return;
    if(last.fingers===2){click('right');return;}
    if(!settings.touchpadTap)return;
    if(last.second){click('left',2);return;}
    tap={at:performance.now()};
    tapTimer=setTimeout(()=>{cancelTap();if(open)click('left');},tapWindow);
  }

  pad.onpointerup=event=>finish(event,false);
  pad.onpointercancel=pad.onlostpointercapture=event=>finish(event,true);
  pad.oncontextmenu=event=>event.preventDefault();
  addEventListener('pagehide',()=>close());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});
  return {get open(){return open;},activate,close,refresh(){
    if(open&&(reason()||epoch!==context()))close();
    else draw();
  }};
};
