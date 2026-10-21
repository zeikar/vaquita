package protocol

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Zero values that carry meaning must stay on the wire: a client reads a
// missing "off" or "ro" as undefined, not as 0 or false.
func TestMessageJSON(t *testing.T) {
	cases := []struct {
		msg  any
		want string
	}{
		{Live{T: TLive, SID: 3, Gen: 7}, `{"t":"live","sid":3,"gen":7,"off":0,"ro":false}`},
		{Ack{T: TAck, SID: 3, Gen: 7}, `{"t":"ack","sid":3,"gen":7,"off":0}`},
	}
	for _, c := range cases {
		b, err := json.Marshal(c.msg)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != c.want {
			t.Errorf("Marshal(%T) = %s, want %s", c.msg, b, c.want)
		}
		got, err := ParseMessage(b)
		if err != nil {
			t.Fatalf("ParseMessage(%s): %v", b, err)
		}
		if !reflect.DeepEqual(got, c.msg) {
			t.Errorf("ParseMessage(%s) = %#v, want %#v", b, got, c.msg)
		}
	}
}
