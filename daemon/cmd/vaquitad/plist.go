package main

import (
	"bytes"
	"encoding/xml"
	"path/filepath"
	"text/template"
)

// ProcessType=Interactive keeps launchd from throttling CPU/IO of the agents
// and builds running inside sessions. AbandonProcessGroup stops launchd from
// killing the daemon's children when it stops the daemon.
var plistTmpl = template.Must(template.New("plist").Funcs(template.FuncMap{
	"esc": func(s string) (string, error) {
		var b bytes.Buffer
		if err := xml.EscapeText(&b, []byte(s)); err != nil {
			return "", err
		}
		return b.String(), nil
	},
}).Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{{esc .Label}}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{esc .Exe}}</string>
		<string>serve</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>VAQUITA_HOME</key>
		<string>{{esc .Home}}</string>
	</dict>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>{{esc .Stderr}}</string>
</dict>
</plist>
`))

func renderPlist(label, exe, home string) []byte {
	var b bytes.Buffer
	err := plistTmpl.Execute(&b, struct{ Label, Exe, Home, Stderr string }{
		label, exe, home, filepath.Join(home, "launchd.stderr.log"),
	})
	if err != nil {
		// The template and its inputs are fixed strings; failure is a bug.
		panic(err)
	}
	return b.Bytes()
}
