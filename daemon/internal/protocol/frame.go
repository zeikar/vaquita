package protocol

import (
	"encoding/binary"
	"errors"
)

// Binary frame types.
const (
	FrameLive   byte = 0x01 // session output as it happens
	FrameReplay byte = 0x02 // session output from the ring, after a Replay
	FrameInput  byte = 0x10 // client to daemon: bytes for the session's PTY
)

const (
	// HeaderSize is the frame header: type u8, sid u32 BE, gen u32 BE.
	HeaderSize = 9
	// MaxPayload bounds a frame's payload; longer data is split.
	MaxPayload = 64 << 10
)

var (
	ErrShortFrame      = errors.New("protocol: frame shorter than its header")
	ErrPayloadTooLarge = errors.New("protocol: frame payload over 64KB")
)

// Frame is one binary WebSocket message.
type Frame struct {
	Type    byte
	SID     uint32
	Gen     uint32
	Payload []byte
}

// Encode returns f as a binary message.
func Encode(f Frame) ([]byte, error) {
	if len(f.Payload) > MaxPayload {
		return nil, ErrPayloadTooLarge
	}
	b := make([]byte, HeaderSize+len(f.Payload))
	b[0] = f.Type
	binary.BigEndian.PutUint32(b[1:5], f.SID)
	binary.BigEndian.PutUint32(b[5:9], f.Gen)
	copy(b[HeaderSize:], f.Payload)
	return b, nil
}

// Decode parses a binary message. The returned Payload aliases b.
func Decode(b []byte) (Frame, error) {
	if len(b) < HeaderSize {
		return Frame{}, ErrShortFrame
	}
	if len(b)-HeaderSize > MaxPayload {
		return Frame{}, ErrPayloadTooLarge
	}
	return Frame{
		Type:    b[0],
		SID:     binary.BigEndian.Uint32(b[1:5]),
		Gen:     binary.BigEndian.Uint32(b[5:9]),
		Payload: b[HeaderSize:],
	}, nil
}
