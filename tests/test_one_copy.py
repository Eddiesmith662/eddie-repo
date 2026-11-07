"""Only one copy at a time (instance.py): Richmond, Nov 6 2026, two copies shared the port all race."""
import socket
import sys
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import instance
import server


class OneCopy(unittest.TestCase):
    def setUp(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]

    def tearDown(self):
        self.sock.close()

    def test_sees_a_copy_running(self):
        self.assertTrue(instance.running(self.port))
        self.sock.close()
        self.assertFalse(instance.running(self.port))

    def test_port_from_the_command_line(self):
        self.assertEqual(instance.port_from([]), 8765)
        self.assertEqual(instance.port_from(["--race-control", "--port", "8800"]), 8800)
        self.assertEqual(instance.port_from(["--port=8801"]), 8801)

    def test_a_second_copy_stops_before_starting_anything(self):
        argv, sys.argv = sys.argv, ["server.py", "--demo", "--port", str(self.port)]
        try:
            self.assertEqual(server.main(), 1)
        finally:
            sys.argv = argv

    def test_the_port_is_never_shared_on_windows(self):
        self.assertEqual(server.QuietServer.allow_reuse_address, server.os.name != "nt")


if __name__ == "__main__":
    unittest.main()
