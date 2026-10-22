package status

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseNotify(t *testing.T) {
	tests := []struct {
		name    string
		num     int
		payload string
		want    Notify
		ok      bool
	}{
		{"osc9", 9, "Approval requested: rm -rf", Notify{Kind: "osc9", Body: "Approval requested: rm -rf"}, true},
		{"osc9 empty", 9, "", Notify{}, false},
		{"osc9 progress", 9, "4;1;50", Notify{}, false},
		{"osc9 cwd", 9, "9;/tmp", Notify{}, false},
		{"osc9 lone number", 9, "42", Notify{Kind: "osc9", Body: "42"}, true},
		{"osc9 number and semicolon", 9, "12;", Notify{}, false},
		{"osc9 digits then text", 9, "2 files changed", Notify{Kind: "osc9", Body: "2 files changed"}, true},
		{"osc777", 777, "notify;Claude Code;Claude needs your permission", Notify{Kind: "osc777", Title: "Claude Code", Body: "Claude needs your permission"}, true},
		{"osc777 body keeps semicolons", 777, "notify;T;a;b;c", Notify{Kind: "osc777", Title: "T", Body: "a;b;c"}, true},
		{"osc777 title only", 777, "notify;T", Notify{Kind: "osc777", Title: "T"}, true},
		{"osc777 other command", 777, "precmd;x;y", Notify{}, false},
		{"osc777 prefix is not notify", 777, "notifyx;T;B", Notify{}, false},
		{"other osc", 7501, "state=idle", Notify{}, false},
	}
	for _, tc := range tests {
		got, ok := ParseNotify(tc.num, []byte(tc.payload))
		if ok != tc.ok || got != tc.want {
			t.Errorf("%s: got %+v, %v; want %+v, %v", tc.name, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseNotifyCapsAndSanitizes(t *testing.T) {
	// 2047 bytes then a 3-byte character straddling the cap.
	n, _ := ParseNotify(9, []byte(strings.Repeat("a", 2047)+"€"))
	if len(n.Body) != 2047 || !utf8.ValidString(n.Body) {
		t.Fatalf("body is %d bytes, valid=%v", len(n.Body), utf8.ValidString(n.Body))
	}
	n, _ = ParseNotify(9, []byte(strings.Repeat("a", 2045)+"€"))
	if len(n.Body) != 2048 {
		t.Fatalf("complete character at the cap lost: %d bytes", len(n.Body))
	}
	n, _ = ParseNotify(9, []byte("a\xffb"))
	if n.Body != "a�b" {
		t.Fatalf("body %q", n.Body)
	}
}
