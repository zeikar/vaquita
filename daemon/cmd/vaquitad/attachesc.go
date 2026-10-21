package main

import "time"

// holdEsc waits escWait for the rest of a bare ESC or ESC [ the key scanner
// holds, which is the Escape key if nothing follows.
func (a *attacher) holdEsc() {
	if a.escTimer != nil {
		a.escTimer.Stop()
		a.escTimer = nil
	}
	if a.keys.bare() {
		a.escTimer = time.NewTimer(a.cfg.escWait)
	}
}

// flushEsc passes on the held ESC as the key it was.
func (a *attacher) flushEsc() *ending {
	p := a.keys.flush()
	if len(p) == 0 || !a.writable || !a.fence.Open() {
		return nil
	}
	return sent(a.c.Input(a.sid, a.gen, p))
}
