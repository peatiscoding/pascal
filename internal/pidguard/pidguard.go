package pidguard

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Start reads the existing PID file (if any), signals the old process to exit,
// waits for it to die, then writes the current PID. A background goroutine
// checks periodically — if a newer instance claims the file, this process exits.
func Start(path string, interval time.Duration) {
	pid := os.Getpid()

	// If old PID file exists, signal old process and wait for it to exit
	if data, err := os.ReadFile(path); err == nil {
		if oldPID, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && oldPID != pid {
			if proc, err := os.FindProcess(oldPID); err == nil {
				// Check if process is alive
				if proc.Signal(syscall.Signal(0)) == nil {
					log.Printf("pidguard: signaling old process %d to exit", oldPID)
					proc.Signal(syscall.SIGTERM)
					// Wait up to 10s for old process to exit
					for i := 0; i < 20; i++ {
						time.Sleep(500 * time.Millisecond)
						if proc.Signal(syscall.Signal(0)) != nil {
							break
						}
					}
				}
			}
		}
	}

	if err := os.WriteFile(path, []byte(strconv.Itoa(pid)), 0644); err != nil {
		log.Fatalf("pidguard: write %s: %v", path, err)
	}
	log.Printf("pidguard: claimed %s (pid %d)", path, pid)

	go func() {
		for {
			time.Sleep(interval)
			data, err := os.ReadFile(path)
			if err != nil {
				log.Printf("pidguard: read %s failed, exiting: %v", path, err)
				os.Exit(1)
			}
			filePID, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				log.Printf("pidguard: invalid pid in %s, exiting", path)
				os.Exit(1)
			}
			if filePID != pid {
				fmt.Fprintf(os.Stderr, "pidguard: %s claimed by pid %d (we are %d), exiting\n", path, filePID, pid)
				os.Exit(0)
			}
		}
	}()
}
