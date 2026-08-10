import { humanStateWords, semanticStationLabel, type SemanticAgent } from "../state/semantic-stations";

export function SemanticStationControls({agents,onSelect}:{agents:readonly SemanticAgent[];onSelect(id:string,element:HTMLButtonElement):void}) {
  return <nav className="stationA11yMirror" aria-label="Agent stations">{agents.map(agent=><button key={agent.id} tabIndex={-1} aria-label={semanticStationLabel(agent)} onClick={event=>onSelect(agent.id,event.currentTarget)}>{agent.name}<span>{humanStateWords[agent.targetState]}</span></button>)}</nav>;
}
