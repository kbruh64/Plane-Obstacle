Drop your Collada (.dae) models here:

  comet88.dae      -> the player plane ("stylized plane comet 88")
  scifi_train.dae  -> obstacle barriers ("sci fi train")

The game loads these via Three.js ColladaLoader. If a file is missing or
fails to load, the game automatically falls back to a procedural low-poly
stand-in so it stays fully playable. Drop the real .dae files in and restart.

DAE models often reference texture images by relative path inside the file —
keep any accompanying texture images (.png/.jpg) next to the .dae here.
