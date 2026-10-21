package status

import (
	"encoding/base64"
	"strings"
	"testing"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestParseReport(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want Report
		ok   bool
	}{
		{"query", "?", Report{Query: true}, true},
		{"minimal", "state=idle", Report{State: "idle"}, true},
		{"full", "state=blocked:kind=permission:id=a/b-1:app=claude-code:progress=40:title=" + b64("T") + ":msg=" + b64("héllo"),
			Report{State: "blocked", Kind: "permission", ID: "a/b-1", App: "claude-code", Progress: 40, HasProgress: true, Title: "T", Msg: "héllo"}, true},
		{"no state", "app=x", Report{}, false},
		{"empty", "", Report{}, false},
		{"invalid state", "state=sleeping", Report{}, false},
		{"state case", "state=Working", Report{}, false},
		{"malformed pairs skipped", "junk:state=done:=x:progress", Report{State: "done"}, true},
		{"unknown key ignored", "state=done:flavor=mint", Report{State: "done"}, true},
		{"repeated keys last wins", "state=idle:state=working:app=a:app=b", Report{State: "working", App: "b"}, true},
		{"invalid state last wins", "state=working:state=nope", Report{}, false},
		{"unpadded base64", "state=done:msg=" + strings.TrimRight(b64("ab"), "="), Report{State: "done", Msg: "ab"}, true},
		{"bad base64 drops field", "state=done:msg=!!!:title=" + b64("t"), Report{State: "done", Title: "t"}, true},
		{"invalid utf8 drops field", "state=done:msg=" + base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe}), Report{State: "done"}, true},
		{"msg at cap", "state=done:msg=" + b64(strings.Repeat("m", 2048)), Report{State: "done", Msg: strings.Repeat("m", 2048)}, true},
		{"msg over cap", "state=done:msg=" + b64(strings.Repeat("m", 2049)), Report{State: "done"}, true},
		{"title over cap", "state=done:title=" + b64(strings.Repeat("t", 193)), Report{State: "done"}, true},
		{"bad kind absent", "state=blocked:kind=maybe", Report{State: "blocked"}, true},
		{"progress zero", "state=working:progress=0", Report{State: "working", HasProgress: true}, true},
		{"progress over", "state=working:progress=101", Report{State: "working"}, true},
		{"progress negative", "state=working:progress=-1", Report{State: "working"}, true},
		{"progress junk", "state=working:progress=x", Report{State: "working"}, true},
		{"app over cap", "state=done:app=" + strings.Repeat("a", 33), Report{State: "done"}, true},
		{"equals inside value", "state=done:app=a=b", Report{State: "done"}, true},
		{"base64 with double padding", "state=done:msg=" + b64("a"), Report{State: "done", Msg: "a"}, true},
		{"padded base64 then garbage", "state=done:msg=YWI=zzz", Report{State: "done"}, true},
		{"app charset", "state=done:app=my app", Report{State: "done"}, true},
		{"app invalid utf8", "state=done:app=caf\xc3", Report{State: "done"}, true},
		{"progress signed", "state=working:progress=+5", Report{State: "working"}, true},
		{"progress 100", "state=working:progress=100", Report{State: "working", Progress: 100, HasProgress: true}, true},
		{"progress long zeros", "state=working:progress=0005", Report{State: "working"}, true},
		{"dot segments allowed", "state=done:id=./..", Report{State: "done", ID: "./.."}, true},
		{"empty id is root", "state=done:id=", Report{State: "done"}, true},
		{"bad id char", "state=done:id=a b", Report{}, false},
		{"bad id empty segment", "state=done:id=a//b", Report{}, false},
		{"bad id trailing slash", "state=done:id=a/", Report{}, false},
		{"bad id long segment", "state=done:id=" + strings.Repeat("a", 33), Report{}, false},
		{"id eight levels", "state=done:id=1/2/3/4/5/6/7/8", Report{State: "done", ID: "1/2/3/4/5/6/7/8"}, true},
		{"bad id nine levels", "state=done:id=1/2/3/4/5/6/7/8/9", Report{}, false},
		{"bad id too long", "state=done:id=" + strings.Repeat(strings.Repeat("a", 32)+"/", 4) + "a", Report{}, false},
	}
	for _, tc := range tests {
		got, ok := ParseReport([]byte(tc.in))
		if ok != tc.ok || got != tc.want {
			t.Errorf("%s: ParseReport(%q) = %+v, %v; want %+v, %v", tc.name, tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
