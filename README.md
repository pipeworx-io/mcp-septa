# mcp-septa

SEPTA MCP — Philadelphia SEPTA real-time transit (www3.septa.org/api, keyless)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `septa_rail_arrivals` | Philadelphia SEPTA Regional Rail departures board for a station — the next trains leaving, grouped Northbound/Southbound with train number, line, destination, scheduled vs estimated departure time, live status ("On Time" or minutes late), and track. Station names are matched forgivingly ("30th street", "ardmore", "suburban" all work). Example: septa_rail_arrivals({ station: "Suburban Station", results: 8 }) |
| `septa_next_to_arrive` | Next SEPTA Regional Rail trains from an origin station to a destination station in Philly — direct trains and connecting itineraries (with transfer station), departure/arrival times, and live delay status. Answers "when is the next train from X to Y" in Philadelphia. Example: septa_next_to_arrive({ orig: "Suburban Station", dest: "Airport Terminal B", n: 3 }) |
| `septa_train_view` | Live positions of every SEPTA Regional Rail train currently running in the Philadelphia region — train number, line, destination, current and next stop, minutes late, and lat/lon. Answers "is my train late" and "where is train 456". Optionally filter to one line. Example: septa_train_view({ line: "Paoli/Thorndale" }) |
| `septa_bus_positions` | Live SEPTA bus and trolley vehicle positions for a route in Philadelphia — each vehicle with direction, destination, next stop, minutes late, estimated seat availability (crowding), and lat/lon. Buses use route numbers ("23", "47"); trolleys use SEPTA Metro codes T1-T5, G1 (Girard), D1/D2 (Media/Sharon Hill) — legacy trolley numbers like "10" are auto-translated to T1. Example: septa_bus_positions({ route: "23" }) |
| `septa_alerts` | SEPTA service alerts, advisories, detours, and suspensions for Philadelphia transit. Pass a route to check one line: a bus number ("23"), a trolley ("T1" or legacy "10"), a Regional Rail line name ("Paoli/Thorndale", "West Trenton", "Airport"), a subway ("Broad Street Line", "Market-Frankford Line", "NHSL"), or a raw route_id ("bus_route_23", "trolley_route_10", "rr_route_pao"). Omit route to list every route with an active alert system-wide. Example: septa_alerts({ route: "Paoli/Thorndale" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "septa": {
      "url": "https://gateway.pipeworx.io/septa/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Septa data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
