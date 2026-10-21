package protocol

import (
	"bytes"
	"errors"
	"testing"
)

func TestFrameRoundtrip(t *testing.T) {
	for _, n := range []int{0, 1, MaxPayload} {
		in := Frame{Type: FrameInput, SID: 0x01020304, Gen: 0xA0B0C0D0, Payload: bytes.Repeat([]byte{'x'}, n)}
		b, err := Encode(in)
		if err != nil {
			t.Fatalf("Encode(%d bytes): %v", n, err)
		}
		if len(b) != HeaderSize+n {
			t.Fatalf("encoded %d bytes, want %d", len(b), HeaderSize+n)
		}
		out, err := Decode(b)
		if err != nil {
			t.Fatalf("Decode(%d bytes): %v", n, err)
		}
		if out.Type != in.Type || out.SID != in.SID || out.Gen != in.Gen || !bytes.Equal(out.Payload, in.Payload) {
			t.Fatalf("roundtrip of %d bytes: got %+v", n, out)
		}
	}
}

func TestFrameHeaderIsBigEndian(t *testing.T) {
	b, err := Encode(Frame{Type: FrameLive, SID: 3, Gen: 7, Payload: []byte("hi")})
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{0x01, 0, 0, 0, 3, 0, 0, 0, 7, 'h', 'i'}
	if !bytes.Equal(b, want) {
		t.Fatalf("Encode = %x, want %x", b, want)
	}
}

func TestEncodeRejectsOversize(t *testing.T) {
	_, err := Encode(Frame{Type: FrameLive, Payload: make([]byte, MaxPayload+1)})
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("err = %v, want ErrPayloadTooLarge", err)
	}
}

func TestDecodeRejects(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want error
	}{
		{"empty", nil, ErrShortFrame},
		{"short header", make([]byte, HeaderSize-1), ErrShortFrame},
		{"oversize payload", make([]byte, HeaderSize+MaxPayload+1), ErrPayloadTooLarge},
	}
	for _, c := range cases {
		if _, err := Decode(c.in); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}
