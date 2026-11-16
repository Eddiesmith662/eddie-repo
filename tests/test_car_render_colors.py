"""Car renders: a colour iRacing gives in a form that can't be read must never stop the overlay.

Nov 14, 2026 (a producer's overnight session, v1.5.48): one driver's licence colour arrived from iRacing as the text
"0xundefined". Reading it failed inside the starting grid, which is built on every telemetry update, so every update
failed from 12:21 AM to 1:39 AM and the overlay showed nothing for the whole session.
Made-up drivers only."""
import unittest

import support  # noqa: F401  (first: throwaway data folder)
import server


def driver(lic_color):
    return {"num": "10", "name": "Test Alpha", "car": "Test Car",
            "paint": {"carPath": "testcar", "carId": 1, "design": "1,ffffff,000000,ff0000", "number": "0,0,ffffff,000000,ff0000",
                      "licColor": lic_color, "clubId": 1, "userId": 1001, "teamId": 0}}


class ColoursFromIRacing(unittest.TestCase):
    def test_the_usual_forms_are_read(self):
        self.assertEqual(server.hex_color("0x0153db"), "0153db")
        self.assertEqual(server.hex_color(87003), "0153db")
        self.assertEqual(server.hex_color("#FF0000"), "ff0000")
        self.assertEqual(server.hex_color(""), "")

    def test_a_colour_that_cant_be_read_is_left_out(self):
        for bad in ("0xundefined", "0x", "undefined", "0xzz"):
            self.assertEqual(server.hex_color(bad), "", bad)

    def test_the_starting_grid_is_built_with_such_a_driver_in_the_field(self):
        drivers = {0: driver("0xundefined"), 1: driver("0x0153db")}
        cars = [{"idx": 0, "best": 30.1}, {"idx": 1, "best": 30.2}]
        grid = server.build_grid(drivers, None, cars)
        self.assertEqual([g["idx"] for g in grid], [0, 1])
        self.assertTrue(all(g["img"].startswith("/carrender/") for g in grid))
        self.assertNotIn("undefined", server.render_url(drivers[0]))


if __name__ == "__main__":
    unittest.main()
