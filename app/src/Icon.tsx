import { iconSvg, markSvg } from './studio/icons.esm.js';
export default function Icon({name, size = 16}: {name:string,size?:number}) { return <span className="fleet-icon" aria-hidden="true" dangerouslySetInnerHTML={{__html: name === 'brand' ? markSvg(size) : iconSvg(name,{size})}} />; }
